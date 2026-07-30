import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  RpcClient,
  type RpcClientError,
  RpcSerialization,
  type RpcGroup,
} from "@effect/rpc";
import { Data, Effect, Layer } from "effect";
import {
  isLocalDaemonError,
  type LocalDaemonError,
  localDaemonCommands,
  LocalDaemonRpcs,
} from "../local-daemon-rpc.js";
import { MoltZapService } from "../service.js";
import {
  dispatchCall,
  type TypedDispatchMap,
  type PayloadForTag,
  type SuccessForTag,
} from "@moltzap/protocol/rpc";

type DaemonRpcs = RpcGroup.Rpcs<typeof LocalDaemonRpcs>;
/** Represents daemon command values. */
export type DaemonCommand = DaemonRpcs["_tag"];
type DaemonClientDispatch = TypedDispatchMap<
  DaemonRpcs,
  RpcClientError.RpcClientError
>;

const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

/** Re-exports the public API from `current module`. */
export { localDaemonCommands };

/** Reports socket request failures. */
export class SocketRequestError extends Data.TaggedError("SocketRequestError")<{
  readonly method: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const socketRequestError = (
  method: string,
  message: string,
  cause?: unknown,
): SocketRequestError => new SocketRequestError({ method, message, cause });

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;

const socketErrorCause = (err: Socket.SocketError): unknown =>
  "cause" in err ? err.cause : err;

const fromSocketError = (
  method: string,
  err: Socket.SocketError,
): SocketRequestError => {
  const cause = socketErrorCause(err);
  const code = errorCode(cause);
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return socketRequestError(
      method,
      "MoltZap service is not running. Start the OpenClaw channel plugin first.",
      cause,
    );
  }
  if ("reason" in err && err.reason === "OpenTimeout") {
    return socketRequestError(method, "Socket request timed out", err);
  }
  return socketRequestError(method, err.message, err);
};

const fromRpcClientError = (method: string, err: unknown): SocketRequestError =>
  socketRequestError(
    method,
    err instanceof Error ? err.message : String(err),
    err,
  );

const fromDaemonCommandError = (
  method: string,
  err: unknown,
): SocketRequestError | LocalDaemonError => {
  if (err instanceof SocketRequestError) {
    return err;
  }
  if (isLocalDaemonError(err)) {
    return err;
  }
  return fromRpcClientError(method, err);
};

const callDaemonClient = <Tag extends DaemonCommand>(
  client: DaemonClientDispatch,
  command: Tag,
  payload: PayloadForTag<DaemonRpcs, Tag>,
): Effect.Effect<SuccessForTag<DaemonRpcs, Tag>, unknown> =>
  dispatchCall<DaemonRpcs, RpcClientError.RpcClientError, Tag>(
    client,
    command,
    payload,
  );

/**
 * Provides the request daemon command runtime value.
 * @param command Value supplied to the operation.
 * @param payload Value supplied to the operation.
 * @param socketPath Value supplied to the operation.
 * @returns The request daemon command result.
 */
export const requestDaemonCommand = <Tag extends DaemonCommand>(
  command: Tag,
  payload: PayloadForTag<DaemonRpcs, Tag>,
  socketPath?: string,
): Effect.Effect<
  SuccessForTag<DaemonRpcs, Tag>,
  SocketRequestError | LocalDaemonError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sockPath = socketPath ?? MoltZapService.SOCKET_PATH;
      const socket = yield* NodeSocket.makeNet({
        path: sockPath,
        openTimeout: `${SOCKET_REQUEST_TIMEOUT_MS} millis`,
      }).pipe(Effect.mapError((err) => fromSocketError(command, err)));
      const protocolLayer = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(Socket.Socket, socket)),
      );
      return yield* Effect.gen(function* () {
        const client: DaemonClientDispatch =
          yield* RpcClient.make(LocalDaemonRpcs);
        return yield* callDaemonClient(client, command, payload);
      }).pipe(
        Effect.provide(protocolLayer),
        Effect.timeoutFail({
          duration: `${SOCKET_REQUEST_TIMEOUT_MS} millis`,
          onTimeout: () =>
            socketRequestError(command, "Socket request timed out"),
        }),
        Effect.mapError((err) => fromDaemonCommandError(command, err)),
      );
    }),
  ).pipe(Effect.withSpan("requestDaemonCommand"));
