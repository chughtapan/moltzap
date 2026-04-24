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
   * Whether the daemon socket is currently reachable. Consulted only when
   * neither `impersonateKey` nor `profileKey` is set and `MOLTZAP_API_KEY`
   * is present in env (spec §5.1 fall-through clause).
   */
  readonly daemonReachable?: boolean;
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
 * Pure decision function. Exported for unit testing — the decision table
 * is covered without touching the network. Spec §5.1 + Invariant §4.2 are
 * enforced by this function: `impersonateKey` present ⇒ never returns
 * `UseDaemon`.
 */
export const decideTransport = (
  _options: TransportOptions,
): TransportDecision => {
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
