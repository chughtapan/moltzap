/**
 * CLI transport layer — the single seam between the command handlers and
 * the wire. Decides between the singleton daemon (Unix socket) and a
 * direct WebSocket per invocation.
 *
 * This file is the `--as <apiKey>` branch point (spec sbd#177 rev 3 §5.1,
 * Invariant §4.2). Command handlers pull `Transport` from Effect context;
 * they do NOT open sockets or construct clients themselves. The kind of
 * transport in effect is decided once at CLI boot by {@link makeTransportLayer}
 * and is immutable for the lifetime of the process.
 *
 * Test seam: integration tests swap {@link makeTransportLayer} for a layer
 * that provides a recording `Transport`; unit tests provide `Transport`
 * directly via `Effect.provideService`.
 */
import * as net from "node:net";
import { Context, Data, Effect, Layer, Scope } from "effect";
import { MoltZapService } from "../service.js";
import { MoltZapWsClient } from "../ws-client.js";
import { request as daemonRequest } from "./socket-client.js";
import type { ProfileError } from "./profile.js";
import {
  loadLayeredConfig,
  parseProfileName,
  resolveProfileAuth,
} from "./profile.js";

// ─── Errors ────────────────────────────────────────────────────────────────

/** Errors any Transport.rpc call may surface. Exhaustive. */
export type TransportError =
  | ServiceUnreachableError
  | TransportTimeoutError
  | TransportRpcError
  | TransportDecodeError
  | TransportConfigError;

/**
 * The daemon socket path did not exist or refused connection. Only raised
 * by the daemon branch; the direct branch never raises this.
 */
export class ServiceUnreachableError extends Data.TaggedError(
  "ServiceUnreachableError",
)<{
  readonly socketPath: string;
  readonly cause: unknown;
}> {}

/** RPC exceeded the per-call deadline without a response frame. */
export class TransportTimeoutError extends Data.TaggedError(
  "TransportTimeoutError",
)<{
  readonly method: string;
  readonly timeoutMs: number;
}> {}

/**
 * Server returned a structured error response frame. `code` matches the
 * JSON-RPC-style error code emitted by `packages/server`.
 */
export class TransportRpcError extends Data.TaggedError("TransportRpcError")<{
  readonly method: string;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/** Response frame failed to parse or did not match the expected RPC result shape. */
export class TransportDecodeError extends Data.TaggedError(
  "TransportDecodeError",
)<{
  readonly method: string;
  readonly cause: unknown;
}> {}

/**
 * Transport inputs were self-inconsistent (e.g., `--as` set with no
 * `serverUrl` resolvable). Surfaces at Layer construction, not at RPC time.
 */
export class TransportConfigError extends Data.TaggedError(
  "TransportConfigError",
)<{
  readonly reason: string;
}> {}

// ─── Transport surface ─────────────────────────────────────────────────────

/**
 * Kind of transport currently in use. Observable for logs and tests.
 * Commands never branch on kind.
 */
export type TransportKind = "daemon" | "direct" | "test";

/**
 * Transport surface used by every CLI command. One generic RPC call; the
 * `kind` is for logs/tests. Commands never branch on `kind`.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly rpc: <Result>(
    method: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<Result, TransportError>;
}

export const Transport = Context.GenericTag<Transport>("moltzap/cli/Transport");

// ─── Layer construction ────────────────────────────────────────────────────

/**
 * Inputs shaping the transport for one CLI invocation. Assembled from
 * parsed CLI options, env, and layered config by the CLI entrypoint.
 * `impersonateKey` wins over `profileKey` wins over daemon.
 */
export interface TransportOptions {
  /** `--as <apiKey>` literal. When set, force direct transport. */
  readonly impersonateKey?: string;
  /** Resolved profile apiKey if `--profile <name>` supplied. */
  readonly profileKey?: string;
  /** Server URL resolved from config + env (wss:// or http://). */
  readonly serverUrl: string;
  /** Daemon socket path (absent only in tests that don't set it). */
  readonly socketPath?: string;
  /**
   * Lazy probe: called ONLY on the env-fallback branch (step 2 below).
   * The as-flag branch never invokes it (Invariant §4.2: --as must not
   * touch the daemon socket, not even to check reachability). Passed as
   * a thunk so the probe is a side effect of the fall-through branch,
   * not of the decision input.
   */
  readonly probeDaemon?: () => Effect.Effect<boolean, never>;
}

/**
 * Decision of which branch {@link makeTransportLayer} selected, exported for
 * log annotations and assertion in tests.
 */
export type TransportDecision =
  | { readonly _tag: "UseDaemon"; readonly socketPath: string }
  | {
      readonly _tag: "UseDirect";
      readonly reason: "as-flag" | "env-fallback" | "profile";
    }
  | { readonly _tag: "UseTest" };

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

/**
 * Decision function — Effect-returning because the env-fallback branch
 * may invoke the `probeDaemon` thunk. The as-flag branch short-circuits
 * BEFORE any probe: `impersonateKey` present ⇒ returns
 * `UseDirect{as-flag}` without calling `probeDaemon`, without reading
 * env, without any side effect (Invariant §4.2).
 */
export const decideTransport = (
  options: TransportOptions,
): Effect.Effect<TransportDecision, never> =>
  Effect.gen(function* () {
    if (options.impersonateKey !== undefined) {
      return { _tag: "UseDirect", reason: "as-flag" } as const;
    }
    if (options.profileKey !== undefined) {
      return { _tag: "UseDirect", reason: "profile" } as const;
    }
    // Env-fallback branch: MOLTZAP_API_KEY is set AND daemon is unreachable.
    const hasEnvKey = process.env.MOLTZAP_API_KEY !== undefined;
    if (hasEnvKey && options.probeDaemon !== undefined) {
      const reachable = yield* options.probeDaemon();
      if (!reachable) {
        return { _tag: "UseDirect", reason: "env-fallback" } as const;
      }
    }
    // Default: daemon branch.
    const socketPath = options.socketPath ?? MoltZapService.SOCKET_PATH;
    return { _tag: "UseDaemon", socketPath } as const;
  });

// Map daemon-branch Error to TransportError tags. The daemon socket client
// surfaces a generic Error; we re-tag at the boundary so command handlers
// can discriminate.
const tagDaemonError = (method: string, err: Error): TransportError => {
  const msg = err.message;
  if (
    msg.includes("not running") ||
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED")
  ) {
    return new ServiceUnreachableError({
      socketPath: MoltZapService.SOCKET_PATH,
      cause: err,
    });
  }
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return new TransportTimeoutError({ method, timeoutMs: 10_000 });
  }
  if (msg.startsWith("Malformed")) {
    return new TransportDecodeError({ method, cause: err });
  }
  // Remote error surfaces as a bare message from the service.
  return new TransportRpcError({
    method,
    code: -32000,
    message: msg,
  });
};

const makeDaemonTransport = (socketPath: string): Transport => ({
  kind: "daemon",
  rpc: <Result>(method: string, params: Record<string, unknown>) =>
    daemonRequest(method, params, socketPath).pipe(
      Effect.map((v) => v as Result),
      Effect.mapError((err) => tagDaemonError(method, err)),
    ),
});

// Map ws-client errors (NotConnectedError | RpcTimeoutError | RpcServerError)
// to TransportError tags. Names are matched via _tag rather than instanceof
// to avoid a circular import chain through runtime/errors.
/** @internal exported for decoder-fixture tests only (sbd#198). */
export const tagWsError = (
  method: string,
  err: {
    readonly _tag?: string;
    readonly message?: string;
    readonly code?: number;
    readonly timeoutMs?: number;
    readonly data?: unknown;
  },
): TransportError => {
  switch (err._tag) {
    case "NotConnectedError":
      return new ServiceUnreachableError({
        socketPath: "(direct-ws)",
        cause: err,
      });
    case "RpcTimeoutError":
      return new TransportTimeoutError({
        method,
        timeoutMs: err.timeoutMs ?? 30_000,
      });
    case "RpcServerError":
      return new TransportRpcError({
        method,
        code: err.code ?? -32000,
        message: err.message ?? "RPC error",
        data: err.data,
      });
    default:
      return new TransportDecodeError({ method, cause: err });
  }
};

/**
 * Build a direct-WebSocket transport. Requires `Scope` so `Layer.scoped`
 * can install a finalizer via `Effect.addFinalizer`. The finalizer fires on
 * fiber interruption (SIGINT/SIGTERM), closing the ws-client and its internal
 * ManagedRuntime + reader fiber. Normal command exits call `process.exit`
 * explicitly via `runHandler`, which preempts the finalizer but terminates
 * the process anyway (see `runHandler` below). This replaces the fragile
 * `process.once("beforeExit", ...)` hook which never fired because the reader
 * fiber kept the event loop non-empty.
 *
 * `sendRpc` is composed entirely in Effect-land — no `Effect.runPromise`
 * bridge — so typed errors (`NotConnectedError`, `RpcTimeoutError`,
 * `RpcServerError`) flow through `tagWsError` without being wrapped in
 * `FiberFailureImpl` (the root cause of sbd#198 / moltzap#228).
 *
 * `Effect.cached` memoises the connect handshake so a command that issues
 * multiple RPCs (e.g. `apps list` then `apps get`) only opens one socket.
 */
const makeDirectTransport = (
  serverUrl: string,
  agentKey: string,
): Effect.Effect<Transport, TransportConfigError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!serverUrl) {
      return yield* Effect.fail(
        new TransportConfigError({
          reason: "direct transport requires a serverUrl",
        }),
      );
    }
    if (!agentKey) {
      return yield* Effect.fail(
        new TransportConfigError({
          reason: "direct transport requires an agentKey",
        }),
      );
    }

    const client = new MoltZapWsClient({ serverUrl, agentKey });

    // Finalizer fires on SIGINT/SIGTERM (fiber interrupt). On normal exits,
    // runHandler calls process.exit which preempts this, but the client is
    // terminated by the OS regardless.
    yield* Effect.addFinalizer(() => client.close());

    // Memoize the connect handshake: only one round-trip per invocation,
    // cached for the lifetime of this scope.
    const connectOnce = yield* Effect.cached(
      client.connect().pipe(Effect.mapError((e) => tagWsError("connect", e))),
    );

    return {
      kind: "direct" as const,
      rpc: <Result>(
        method: string,
        params: Record<string, unknown>,
      ): Effect.Effect<Result, TransportError> =>
        connectOnce.pipe(
          Effect.flatMap(() =>
            client
              .sendRpc(method, params)
              .pipe(Effect.mapError((e) => tagWsError(method, e))),
          ),
          Effect.map((v) => v as Result),
        ),
    };
  });

/**
 * Build the Layer that provides {@link Transport} for the current invocation.
 *
 * Branch points (in priority order):
 *   1. `options.impersonateKey` → direct WS, Invariant §4.2 isolation guaranteed.
 *   2. `process.env.MOLTZAP_API_KEY` present AND daemon unreachable → direct WS.
 *   3. `options.profileKey` set → direct WS with that key.
 *   4. otherwise → daemon transport over `options.socketPath`.
 *
 * The direct branch must NOT open the daemon socket, mutate
 * `~/.moltzap/config.json`, or share any Effect fiber with the daemon.
 * Integration test §7 of the design doc verifies this with a two-agent
 * concurrent roster.
 */
export const makeTransportLayer = (
  options: TransportOptions,
): Layer.Layer<Transport, TransportConfigError> =>
  Layer.scoped(
    Transport,
    Effect.gen(function* () {
      const decision = yield* decideTransport(options);
      switch (decision._tag) {
        case "UseDaemon":
          return makeDaemonTransport(decision.socketPath);
        case "UseDirect": {
          let key: string | undefined;
          switch (decision.reason) {
            case "as-flag":
              key = options.impersonateKey;
              break;
            case "profile":
              key = options.profileKey;
              break;
            case "env-fallback":
              key = process.env.MOLTZAP_API_KEY;
              break;
          }
          if (key === undefined) {
            return yield* Effect.fail(
              new TransportConfigError({
                reason: `direct transport (${decision.reason}) requires an apiKey`,
              }),
            );
          }
          return yield* makeDirectTransport(options.serverUrl, key);
        }
        case "UseTest":
          return yield* Effect.fail(
            new TransportConfigError({
              reason:
                "UseTest is a test-only branch; provide Transport via Effect.provideService",
            }),
          );
        default:
          return absurd(decision);
      }
    }),
  );

/**
 * Convenience for command handlers: pull the Transport tag and call rpc.
 * Every new subcommand routes through this helper; raw `socket-client.request`
 * imports in new commands are a lint-level violation (see design doc §3).
 */
export const rpc = <Result>(
  method: string,
  params: Record<string, unknown>,
): Effect.Effect<Result, TransportError, Transport> =>
  Effect.flatMap(Transport, (t) => t.rpc<Result>(method, params));

/**
 * Uniform error-to-exit adapter for subcommand handlers. Catches every error
 * channel, prints `Failed: <msg>` to stderr, and exits non-zero. Uses the
 * tagged-error `message` field if present, otherwise the `_tag`, otherwise
 * a generic fallback. Shared across every v2 subcommand wrapper so the
 * exit-code contract (Invariant §4.6) has a single implementation.
 *
 * Both branches call `process.exit` explicitly. On success, `exit(0)` flushes
 * any lingering event-loop handles (e.g. the ws-client's ManagedRuntime
 * dispose) that would otherwise prevent the one-shot CLI process from
 * terminating naturally (sbd#198 / moltzap#228 Bug-2 fix).
 */
export const runHandler = <
  E extends { readonly message?: string; readonly _tag?: string },
>(
  effect: Effect.Effect<void, E, Transport>,
): Effect.Effect<void, never, Transport> =>
  effect.pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        const msg =
          err.message !== undefined && err.message !== ""
            ? err.message
            : (err._tag ?? "unknown error");
        console.error(`Failed: ${msg}`);
        process.exit(1);
      }),
    ),
    Effect.zipRight(Effect.sync(() => process.exit(0))),
  );

/**
 * Lazy resolver invoked by the CLI entrypoint BEFORE constructing the
 * transport layer. Closes the composition-boundary leak (architect design
 * doc rev 4 finding 1): with `impersonateKey` set, this function does NOT
 * call `cli/config.ts:loadConfig`, does NOT read `MOLTZAP_API_KEY` env,
 * does NOT open `~/.moltzap/config.json`. The only resolution performed on
 * the as-flag branch is `MOLTZAP_SERVER_URL` (or the hard-coded default).
 *
 * This function is the true CLI-boundary gate on Invariant §4.2 — without
 * it, eager config-read side effects leak even when `decideTransport` is
 * later short-circuited. Unit tests assert on `fs.open` and `env` read
 * spies that zero calls happen on the `impersonateKey` branch.
 */
export const resolveTransportInputs = (parsed: {
  readonly impersonateKey?: string;
  readonly profileName?: string;
}): Effect.Effect<TransportOptions, TransportConfigError | ProfileError> =>
  Effect.gen(function* () {
    // ─── Branch A: impersonate (--as) ──────────────────────────────────────
    // Invariant §4.2: no loadConfig, no MOLTZAP_API_KEY read, no config.json open.
    if (parsed.impersonateKey !== undefined) {
      const serverUrl = process.env.MOLTZAP_SERVER_URL ?? DEFAULT_SERVER_URL;
      return {
        impersonateKey: parsed.impersonateKey,
        serverUrl,
      };
    }
    // ─── Branch B: profile ─────────────────────────────────────────────────
    if (parsed.profileName !== undefined) {
      const name = yield* parseProfileName(parsed.profileName);
      const layered = yield* loadLayeredConfig;
      const record = yield* resolveProfileAuth(name);
      const serverUrl =
        process.env.MOLTZAP_SERVER_URL ?? record.serverUrl ?? layered.serverUrl;
      return {
        profileKey: record.apiKey,
        serverUrl,
        socketPath: MoltZapService.SOCKET_PATH,
        probeDaemon: probeDaemonDefault,
      };
    }
    // ─── Branch C: legacy daemon / env fallback ────────────────────────────
    const serverUrl = process.env.MOLTZAP_SERVER_URL ?? DEFAULT_SERVER_URL;
    return {
      serverUrl,
      socketPath: MoltZapService.SOCKET_PATH,
      probeDaemon: probeDaemonDefault,
    };
  });

/**
 * Default daemon reachability probe: attempt a real connect to the daemon
 * socket and resolve on `connect`. A bare `fs.existsSync` would mis-report
 * a stale socket file as "reachable" and route env-fallback callers into
 * a broken daemon branch; a real connect is the only honest reachability
 * check. 250ms cap keeps boot latency invisible on the common fast-local
 * path and still fails fast when the socket refuses or hangs.
 */
const probeDaemonDefault = (): Effect.Effect<boolean, never> =>
  Effect.async<boolean, never>((resume) => {
    let settled = false;
    const done = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.removeAllListeners();
      conn.destroy();
      resume(Effect.succeed(reachable));
    };
    const conn = net.createConnection(MoltZapService.SOCKET_PATH);
    const timer = setTimeout(() => done(false), 250);
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
  });

function absurd(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}
