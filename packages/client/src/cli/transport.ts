/**
 * CLI transport layer — the single seam between the command handlers and
 * the wire. Decides between the singleton daemon (Unix socket) and a
 * direct WebSocket per invocation.
 *
 * This file is the `--as &lt;apiKey>` branch point. Command handlers pull
 * `Transport` from Effect context;
 * they do NOT open sockets or construct clients themselves. The kind of
 * transport in effect is decided once at CLI boot by {@link makeTransportLayer}
 * and is immutable for the lifetime of the process.
 *
 * Test seam: integration tests swap {@link makeTransportLayer} for a layer
 * that provides a recording `Transport`; unit tests provide `Transport`
 * directly via `Effect.provideService`.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Config,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Scope,
} from "effect";
import { MoltZapService } from "../service.js";
import {
  NotConnectedError,
  RpcTimeoutError,
  AgentCallableGroup,
} from "@moltzap/protocol";
import type { RpcGroup } from "@effect/rpc";
import { MoltZapAgentClient } from "../agent-client.js";
import { request as daemonRequest } from "./socket-client.js";
import type { ProfileError } from "./profile.js";
import {
  loadLayeredConfig,
  parseProfileName,
  resolveProfileAuth,
} from "./profile.js";
import type {
  PayloadForTag,
  SuccessForTag,
} from "../runtime/typed-dispatch.js";

/** The agent group's member `Rpc`s — the tag-keyed CLI transport surface. */
type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;

/** The branded wire tags the CLI may originate. */
type AgentCallableTag = AgentCallableRpcs["_tag"];

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
 * Server returned a typed wire `error` for a request. `tag` is the failing
 * method's tagged-error discriminant (e.g. `"TaskRejected"`, `"Forbidden"`) —
 * the `_tag` the engine decoded the error against, not a numeric code.
 */
export class TransportRpcError extends Data.TaggedError("TransportRpcError")<{
  readonly method: string;
  readonly tag: string;
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
export const DIRECT_TRANSPORT_KIND = "direct";

type TransportKind = "daemon" | typeof DIRECT_TRANSPORT_KIND | "test";

/**
 * Transport surface used by every CLI command. One typed per-method call keyed
 * by wire tag; the `kind` is for logs/tests. Commands never branch on `kind`.
 * The agent group's tags are the only callable surface.
 */
export interface Transport {
  readonly kind: TransportKind;
  readonly rpc: <Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
  ) => Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, TransportError>;
}

export const Transport = Context.GenericTag<Transport>("moltzap/cli/Transport");

// ─── Layer construction ────────────────────────────────────────────────────

/**
 * Inputs shaping the transport for one CLI invocation. Assembled from
 * parsed CLI options, env, and layered config by the CLI entrypoint.
 * `impersonateKey` wins over `profileKey` wins over daemon.
 */
export interface TransportOptions {
  /** `--as &lt;apiKey>` literal. When set, force direct transport. */
  readonly impersonateKey?: string;
  /** Resolved profile apiKey if `--profile &lt;name>` supplied. */
  readonly profileKey?: string;
  /** Resolved MOLTZAP_API_KEY for the legacy direct fallback branch. */
  readonly envFallbackKey?: string;
  /** Server URL resolved from config + env (wss:// or http://). */
  readonly serverUrl: string;
  /** Daemon socket path (absent only in tests that don't set it). */
  readonly socketPath?: string;

  /**
   * Lazy probe: called ONLY on the env-fallback branch (step 2 below).
   * The as-flag branch never invokes it: --as must not touch the daemon
   * socket, not even to check reachability. Passed as a thunk so the probe
   * is a side effect of the fall-through branch, not of the decision input.
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
const DAEMON_TIMEOUT_MS = 10_000;
const JSON_RPC_SERVER_ERROR_CODE = -32000;
const PROBE_DAEMON_TIMEOUT_MS = 250;

const EnvServerUrl = Config.option(Config.string("MOLTZAP_SERVER_URL"));
const EnvApiKey = Config.option(Config.redacted("MOLTZAP_API_KEY"));

type DirectTransportDecision = Extract<
  TransportDecision,
  { readonly _tag: "UseDirect" }
>;

const loadEnvServerUrl: Effect.Effect<string | undefined, never> =
  EnvServerUrl.pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
const loadEnvServerUrlWithDefault: Effect.Effect<string, never> =
  loadEnvServerUrl.pipe(
    Effect.map((serverUrl) => serverUrl ?? DEFAULT_SERVER_URL),
  );
const loadEnvApiKey: Effect.Effect<string | undefined, never> = EnvApiKey.pipe(
  Effect.map((value) =>
    Option.match(value, {
      onNone: () => undefined,
      onSome: Redacted.value,
    }),
  ),
  Effect.orElseSucceed(() => undefined),
);

const selectDirectTransportKey = (
  decision: DirectTransportDecision,
  options: TransportOptions,
): string | undefined => {
  const keyByReason = {
    "as-flag": options.impersonateKey,
    "env-fallback": options.envFallbackKey,
    profile: options.profileKey,
  } satisfies Record<DirectTransportDecision["reason"], string | undefined>;

  return keyByReason[decision.reason];
};

/**
 * Decision function — Effect-returning because the env-fallback branch
 * may invoke the `probeDaemon` thunk. The as-flag branch short-circuits
 * BEFORE any probe: `impersonateKey` present ⇒ returns
 * `UseDirect{as-flag}` without calling `probeDaemon`, without reading
 * env, without any side effect.
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
    const hasEnvKey = options.envFallbackKey !== undefined;
    if (hasEnvKey && options.probeDaemon !== undefined) {
      const reachable = yield* options.probeDaemon();
      if (!reachable) {
        return { _tag: "UseDirect", reason: "env-fallback" } as const;
      }
    }
    // Default: daemon branch.
    const socketPath = options.socketPath ?? MoltZapService.SOCKET_PATH;
    return { _tag: "UseDaemon", socketPath } as const;
  }).pipe(Effect.withSpan("decideTransport"));

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
    return new TransportTimeoutError({ method, timeoutMs: DAEMON_TIMEOUT_MS });
  }
  if (msg.startsWith("Malformed")) {
    return new TransportDecodeError({ method, cause: err });
  }
  // Remote error surfaces as a bare message from the daemon; it is not a
  // decoded tagged error, so it carries the generic server-error tag.
  return new TransportRpcError({
    method,
    tag: "ServerError",
    message: msg,
  });
};

const makeDaemonTransport = (socketPath: string): Transport => ({
  kind: "daemon",
  rpc: (tag, payload) =>
    daemonRequest(tag, payload, socketPath).pipe(
      Effect.mapError((err) => tagDaemonError(tag, err)),
    ),
});

/**
 * A domain wire error decoded by the engine — any `Schema.TaggedError` instance
 * with a `_tag` discriminant. Maps to `TransportRpcError` carrying that `_tag`.
 * Returns null when `err` is not a tagged-error record (caller falls through to
 * a decode error).
 */
function mapTaggedWireError(
  method: string,
  err: unknown,
): TransportRpcError | null {
  if (typeof err !== "object" || err === null || !("_tag" in err)) {
    return null;
  }
  const payload = err as {
    readonly _tag: string;
    readonly message?: string;
    readonly data?: unknown;
  };
  return new TransportRpcError({
    method,
    tag: payload._tag,
    message: payload.message ?? payload._tag,
    data: payload.data,
  });
}

/**
 * Map a typed call error to the CLI's `TransportError`. Transport-level
 * `NotConnectedError`/`RpcTimeoutError` map to their reachability/timeout
 * variants; every other failure is a method's tagged wire error, mapped to
 * `TransportRpcError` by `_tag`.
 *
 * Exported for decoder-fixture tests only.
 * @internal
 */
export const tagWsError = (method: string, err: unknown): TransportError => {
  if (err instanceof NotConnectedError) {
    return new ServiceUnreachableError({
      socketPath: "(direct-ws)",
      cause: err,
    });
  }
  if (err instanceof RpcTimeoutError) {
    return new TransportTimeoutError({
      method,
      timeoutMs: err.timeoutMs,
    });
  }
  const tagged = mapTaggedWireError(method, err);
  if (tagged !== null) {
    return tagged;
  }
  return new TransportDecodeError({ method, cause: err });
};

type DirectConnectOnce = Effect.Effect<MoltZapAgentClient, TransportError>;

function mapDirectRpcError(method: string): (err: unknown) => TransportError {
  return (err) => tagWsError(method, err);
}

function sendDirectRpc<Tag extends AgentCallableTag>(
  connectOnce: DirectConnectOnce,
  tag: Tag,
  payload: PayloadForTag<AgentCallableRpcs, Tag>,
): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, TransportError> {
  return connectOnce.pipe(
    Effect.flatMap((client) =>
      client.call(tag, payload).pipe(Effect.mapError(mapDirectRpcError(tag))),
    ),
  );
}

/**
 * Build a direct-WebSocket transport. Requires `Scope` so `Layer.scoped`
 * can install a finalizer via `Effect.addFinalizer`. The finalizer fires on
 * fiber interruption (SIGINT/SIGTERM) — closing the ws-client and its internal
 * ManagedRuntime — and also runs on normal completion so the event loop drains
 * naturally without a forced `process.exit`. A `process.once("beforeExit", ...)`
 * hook would not fire here because the reader fiber keeps the event loop
 * non-empty, so the scope finalizer is the reliable teardown path.
 *
 * `MoltZapAgentClient` is constructed lazily inside `Effect.cached` so commands
 * that never reach the wire (e.g. help-text display, input validation failure)
 * do not pay for a ManagedRuntime spin-up.
 *
 * `sendRpc` is composed entirely in Effect-land — no `Effect.runPromise`
 * bridge — so typed errors (`NotConnectedError`, `RpcTimeoutError`,
 * `RpcServerError`) flow through `tagWsError` with their `_tag` intact.
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

    // Lazily-created client: null until the first rpc() call fires connectOnce.
    // The finalizer checks the current value at scope-close time so help/
    // validation paths that never open a socket incur no cleanup cost.
    let client: MoltZapAgentClient | null = null;
    yield* Effect.addFinalizer(() =>
      client !== null ? client.close() : Effect.void,
    );

    // Memoize the connect handshake: only one round-trip per invocation,
    // cached for the lifetime of this scope.
    const connectOnce = yield* Effect.cached(
      Effect.gen(function* () {
        const c = new MoltZapAgentClient({ serverUrl, agentKey });
        client = c;
        yield* c
          .connect()
          .pipe(Effect.mapError((e) => tagWsError("connect", e)));
        return c;
      }),
    );

    return {
      kind: DIRECT_TRANSPORT_KIND,
      rpc: (tag, payload) => sendDirectRpc(connectOnce, tag, payload),
    };
  });

/**
 * Build the Layer that provides {@link Transport} for the current invocation.
 *
 * Branch points (in priority order):
 *   1. `options.impersonateKey` → direct WS, isolated from the daemon.
 *   2. `process.env.MOLTZAP_API_KEY` present AND daemon unreachable → direct WS.
 *   3. `options.profileKey` set → direct WS with that key.
 *   4. otherwise → daemon transport over `options.socketPath`.
 *
 * The direct branch must NOT open the daemon socket, mutate
 * `~/.moltzap/config.json`, or share any Effect fiber with the daemon.
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
          const key = selectDirectTransportKey(decision, options);
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
    }).pipe(Effect.withSpan("makeTransportLayer")),
  );

/**
 * Convenience for command handlers: pull the Transport tag and call rpc.
 * Every subcommand routes through this helper; command handlers do not
 * import `socket-client.request` directly.
 */
export const rpc = <Tag extends AgentCallableTag>(
  tag: Tag,
  payload: PayloadForTag<AgentCallableRpcs, Tag>,
): Effect.Effect<
  SuccessForTag<AgentCallableRpcs, Tag>,
  TransportError,
  Transport
> => Effect.flatMap(Transport, (t) => t.rpc(tag, payload));

/**
 * Uniform error-to-exit adapter for subcommand handlers. Catches every error
 * channel, prints `Failed: &lt;msg>` to stderr, and exits non-zero. Uses the
 * tagged-error `message` field if present, otherwise the `_tag`, otherwise
 * a generic fallback. Shared across every subcommand wrapper so the
 * exit-code contract has a single implementation.
 *
 * On success, this returns normally and relies on the `Layer.scoped`
 * finalizer in `makeDirectTransport` to close the ws-client and drain
 * the event loop. No forced `process.exit(0)` — that would truncate piped
 * stdout on large payloads.
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
  );

/**
 * Lazy resolver invoked by the CLI entrypoint BEFORE constructing the
 * transport layer. Keeps the as-flag branch isolated: with
 * `impersonateKey` set, this function does NOT call
 * `cli/config.ts:loadConfig`, does NOT read `MOLTZAP_API_KEY` env, does
 * NOT open `~/.moltzap/config.json`. The only resolution performed on the
 * as-flag branch is `MOLTZAP_SERVER_URL` (or the hard-coded default).
 *
 * This function is the CLI-boundary gate that keeps the as-flag branch
 * isolated — without it, eager config-read side effects leak even when
 * `decideTransport` is later short-circuited. Unit tests assert on
 * `fs.open` and `env` read spies that zero calls happen on the
 * `impersonateKey` branch.
 */
export const resolveTransportInputs = (parsed: {
  readonly impersonateKey?: string;
  readonly profileName?: string;
}): Effect.Effect<TransportOptions, TransportConfigError | ProfileError> =>
  Effect.gen(function* () {
    // ─── Branch A: impersonate (--as) ──────────────────────────────────────
    // No loadConfig, no MOLTZAP_API_KEY read, no config.json open.
    if (parsed.impersonateKey !== undefined) {
      const serverUrl = yield* loadEnvServerUrlWithDefault;
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
      const serverUrl = yield* loadEnvServerUrl;
      return {
        profileKey: record.apiKey,
        serverUrl: serverUrl ?? record.serverUrl ?? layered.serverUrl,
        socketPath: MoltZapService.SOCKET_PATH,
        probeDaemon: probeDaemonDefault,
      };
    }
    // ─── Branch C: legacy daemon / env fallback ────────────────────────────
    const serverUrl = yield* loadEnvServerUrlWithDefault;
    const envFallbackKey = yield* loadEnvApiKey;
    return {
      ...(envFallbackKey !== undefined ? { envFallbackKey } : {}),
      serverUrl,
      socketPath: MoltZapService.SOCKET_PATH,
      probeDaemon: probeDaemonDefault,
    };
  }).pipe(Effect.withSpan("resolveTransportInputs"));

/**
 * Default daemon reachability probe: attempt a real connect to the daemon
 * socket and resolve on `connect`. A bare `fs.existsSync` would mis-report
 * a stale socket file as "reachable" and route env-fallback callers into
 * a broken daemon branch; a real connect is the only honest reachability
 * check. 250ms cap keeps boot latency invisible on the common fast-local
 * path and still fails fast when the socket refuses or hangs.
 */
const probeDaemonDefault = (): Effect.Effect<boolean, never> =>
  Effect.scoped(
    NodeSocket.makeNet({
      path: MoltZapService.SOCKET_PATH,
      openTimeout: `${PROBE_DAEMON_TIMEOUT_MS} millis`,
    }).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  );

function absurd(x: never): never {
  throw new Error(`unreachable: ${String(x)}`);
}
