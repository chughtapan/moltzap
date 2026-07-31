/**
 * CLI transport layer — the single boundary between the command handlers and
 * the local daemon socket.
 *
 * Command handlers pull `Transport` from Effect context; they do NOT open
 * sockets or construct clients themselves. The kind of
 * transport in effect is decided once at CLI boot by {@link makeTransportLayer}
 * and is immutable for the lifetime of the process.
 *
 * Test seam: integration tests swap {@link makeTransportLayer} for a layer
 * that provides a recording `Transport`; unit tests provide `Transport`
 * directly via `Effect.provideService`.
 */
import { Context, Data, Effect, Layer } from "effect";
import { MoltZapService } from "../service.js";
import type { RpcGroup } from "@effect/rpc";
import { getMoltZapAgentServiceSocketPath } from "../local-paths.js";
import { requestDaemonCommand, SocketRequestError } from "./socket-client.js";
import { type LocalDaemonError, LocalDaemonRpcs } from "../local-daemon-rpc.js";
import {
  resolveProfileRecord,
  type ProfileError,
  type ProfileName,
} from "../profile.js";
import type { PayloadForTag, SuccessForTag } from "@moltzap/protocol/rpc";

/** The local daemon command group's member `Rpc`s. */
type DaemonRpcs = RpcGroup.Rpcs<typeof LocalDaemonRpcs>;

/** The local command tags the CLI may originate. */
type DaemonCommand = DaemonRpcs["_tag"];

// ─── Errors ────────────────────────────────────────────────────────────────

/** Errors any Transport.rpc call may surface. Exhaustive. */
export type TransportError =
  | ServiceUnreachableError
  | TransportTimeoutError
  | TransportRpcError
  | TransportDecodeError
  | LocalDaemonError;

/**
 * The daemon socket path did not exist or refused connection. Only raised
 * by the daemon path.
 */
class ServiceUnreachableError extends Data.TaggedError(
  "ServiceUnreachableError",
)<{
  readonly socketPath: string;
  readonly cause: unknown;
}> {}

/** RPC exceeded the per-call deadline without a response frame. */
class TransportTimeoutError extends Data.TaggedError("TransportTimeoutError")<{
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
class TransportDecodeError extends Data.TaggedError("TransportDecodeError")<{
  readonly method: string;
  readonly cause: unknown;
}> {}

// ─── Transport surface ─────────────────────────────────────────────────────

/**
 * Transport surface used by every CLI command. One typed per-command call keyed
 * by local daemon command.
 */
export interface Transport {
  readonly command: <Tag extends DaemonCommand>(
    tag: Tag,
    payload: PayloadForTag<DaemonRpcs, Tag>,
  ) => Effect.Effect<SuccessForTag<DaemonRpcs, Tag>, TransportError>;
}

export const Transport = Context.GenericTag<Transport>("moltzap/cli/Transport");

// ─── Layer construction ────────────────────────────────────────────────────

/**
 * Inputs shaping the transport for one CLI invocation. Assembled from
 * parsed CLI options and profile config by the CLI entrypoint.
 */
export interface TransportOptions {
  /** Selected daemon socket path for this invocation. */
  readonly socketPath: string;
}

const DAEMON_TIMEOUT_MS = 10_000;

// Map local socket faults to CLI transport tags. Errors decoded from the daemon
// RPC error channel are already typed tagged errors and pass through unchanged.
function tagDaemonError(
  method: string,
  err: SocketRequestError | LocalDaemonError,
  socketPath: string,
): TransportError {
  if (!(err instanceof SocketRequestError)) return err;
  const msg = err.message;
  if (
    msg.includes("not running") ||
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED")
  ) {
    return new ServiceUnreachableError({
      socketPath,
      cause: err,
    });
  }
  if (msg.includes("timed out") || msg.includes("aborted")) {
    return new TransportTimeoutError({ method, timeoutMs: DAEMON_TIMEOUT_MS });
  }
  if (msg.startsWith("Malformed")) {
    return new TransportDecodeError({ method, cause: err });
  }
  return new TransportRpcError({
    method,
    tag: err._tag,
    message: msg,
  });
}

function makeDaemonTransport(socketPath: string): Transport {
  return {
    command: (tag, payload) =>
      requestDaemonCommand(tag, payload, socketPath).pipe(
        Effect.mapError((err) => tagDaemonError(tag, err, socketPath)),
      ),
  };
}

/** Build the Layer that provides {@link Transport} for the current invocation. */
export const makeTransportLayer = (
  options: TransportOptions,
): Layer.Layer<Transport> =>
  Layer.succeed(Transport, makeDaemonTransport(options.socketPath));

/**
 * Convenience for command handlers: pull the Transport tag and call a daemon
 * command.
 * Every subcommand routes through this helper; command handlers do not
 * import `socket-client` directly.
 */
export const command = <Tag extends DaemonCommand>(
  tag: Tag,
  payload: PayloadForTag<DaemonRpcs, Tag>,
): Effect.Effect<SuccessForTag<DaemonRpcs, Tag>, TransportError, Transport> =>
  Effect.flatMap(Transport, (t) => t.command(tag, payload));

/**
 * Uniform error-to-exit adapter for subcommand handlers. Catches every error
 * channel, prints `Failed: &lt;msg>` to stderr, and exits non-zero. Uses the
 * tagged-error `message` field if present, otherwise the `_tag`, otherwise
 * a generic fallback. Shared across every subcommand wrapper so the
 * exit-code contract has a single implementation.
 *
 * No forced `process.exit(0)` — that would truncate piped stdout on large
 * payloads.
 */
export const runHandler = <
  E extends { readonly message?: string; readonly _tag?: string },
  R,
>(
  effect: Effect.Effect<void, E, R>,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.catchAll((err) => {
      const msg =
        err.message !== undefined && err.message !== ""
          ? err.message
          : (err._tag ?? "unknown error");
      return Effect.logError(`Failed: ${msg}`).pipe(
        Effect.zipRight(Effect.sync(() => process.exit(1))),
      );
    }),
  );

/**
 * Lazy resolver invoked by the CLI entrypoint BEFORE constructing the
 * transport layer. With `profileName` set, this resolves the named profile
 * into the profile agent's daemon socket; otherwise it uses the default
 * daemon socket.
 */
export const resolveTransportInputs = (parsed: {
  readonly profileName?: ProfileName;
}): Effect.Effect<TransportOptions, ProfileError> =>
  Effect.gen(function* () {
    // ─── Branch A: profile ─────────────────────────────────────────────────
    if (parsed.profileName !== undefined) {
      const record = yield* resolveProfileRecord(parsed.profileName);
      return {
        socketPath: getMoltZapAgentServiceSocketPath(record.agentId),
      };
    }
    // ─── Branch B: daemon ──────────────────────────────────────────────────
    return {
      socketPath: MoltZapService.SOCKET_PATH,
    };
  }).pipe(Effect.withSpan("resolveTransportInputs"));
