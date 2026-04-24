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
import { Context, Data, Effect, Layer } from "effect";

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

/**
 * Decision function — Effect-returning because the env-fallback branch
 * may invoke the `probeDaemon` thunk. The as-flag branch short-circuits
 * BEFORE any probe: `impersonateKey` present ⇒ returns
 * `UseDirect{as-flag}` without calling `probeDaemon`, without reading
 * env, without any side effect (Invariant §4.2).
 */
export const decideTransport = (
  _options: TransportOptions,
): Effect.Effect<TransportDecision, never> => {
  throw new Error("not implemented");
};

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
  _options: TransportOptions,
): Layer.Layer<Transport, TransportConfigError> => {
  throw new Error("not implemented");
};

/**
 * Convenience for command handlers: pull the Transport tag and call rpc.
 * Every new subcommand routes through this helper; raw `socket-client.request`
 * imports in new commands are a lint-level violation (see design doc §3).
 */
export const rpc = <Result>(
  _method: string,
  _params: Record<string, unknown>,
): Effect.Effect<Result, TransportError, Transport> => {
  throw new Error("not implemented");
};

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
export const resolveTransportInputs = (
  _parsed: {
    readonly impersonateKey?: string;
    readonly profileName?: string;
  },
): Effect.Effect<TransportOptions, TransportConfigError> => {
  throw new Error("not implemented");
};
