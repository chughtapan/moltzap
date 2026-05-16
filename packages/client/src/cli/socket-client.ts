import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { RpcClient, RpcClientError, RpcSerialization } from "@effect/rpc";
import { Data, Effect, Layer } from "effect";
import {
  LocalDaemonRpcs,
  normalizeLocalDaemonParams,
} from "../local-daemon-rpc.js";
import { MoltZapService } from "../service.js";
import {
  LocalServiceCommands,
  type LocalServiceCommand,
} from "../runtime/local-service-commands.js";

import {
  AgentsLookupByName,
  type ParamsOf,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";

const SOCKET_REQUEST_TIMEOUT_MS = 10_000;

export { LocalServiceCommands };
export type { LocalServiceCommand };

export class SocketRequestError extends Data.TaggedError("SocketRequestError")<{
  readonly method: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

class ParticipantResolveError extends Data.TaggedError(
  "ParticipantResolveError",
)<{
  readonly input: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SocketClientError = SocketRequestError | ParticipantResolveError;

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

const fromRpcClientError = (
  method: string,
  err: RpcClientError.RpcClientError,
): SocketRequestError => socketRequestError(method, err.message, err);

const fromLocalDaemonCallError = (
  method: string,
  err: string | RpcClientError.RpcClientError | SocketRequestError,
): SocketRequestError => {
  if (err instanceof SocketRequestError) return err;
  if (typeof err === "string") return socketRequestError(method, err);
  return fromRpcClientError(method, err);
};

/**
 * Send a request to the MoltZapService via the local daemon RPC socket. Typed failures:
 *   - "service not running" when the socket path doesn't exist / ECONNREFUSED
 *   - "timeout" when the 10s deadline elapses
 *   - remote validation/RPC errors from the daemon
 *   - protocol errors from `@effect/rpc`
 */
export const request = <D extends RpcDefinition<string, any, any>>(
  definition: D,
  params: ParamsOf<D>,
  socketPath?: string,
): Effect.Effect<ResultOf<D>, SocketRequestError> =>
  Effect.suspend(() => {
    const resolvedSocketPath = socketPath ?? MoltZapService.SOCKET_PATH;
    return sendSocketRequest(definition.name, params, resolvedSocketPath).pipe(
      Effect.flatMap((result) =>
        definition.validateResult(result)
          ? Effect.succeed(result as ResultOf<D>)
          : Effect.fail(
              socketRequestError(
                definition.name,
                `Malformed result for method: ${definition.name}`,
                result,
              ),
            ),
      ),
    );
  });

export const requestLocalService = (
  command: LocalServiceCommand,
  params?: Record<string, unknown>,
  socketPath?: string,
): Effect.Effect<unknown, SocketRequestError> =>
  Effect.suspend(() => {
    const resolvedParams = params ?? {};
    const resolvedSocketPath = socketPath ?? MoltZapService.SOCKET_PATH;
    return sendSocketRequest(command, resolvedParams, resolvedSocketPath);
  });

export const sendSocketRequest = (
  method: string,
  params: unknown,
  socketPath?: string,
): Effect.Effect<unknown, SocketRequestError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sockPath = socketPath ?? MoltZapService.SOCKET_PATH;
      const socket = yield* NodeSocket.makeNet({
        path: sockPath,
        openTimeout: `${SOCKET_REQUEST_TIMEOUT_MS} millis`,
      }).pipe(Effect.mapError((err) => fromSocketError(method, err)));
      const localParams = yield* normalizeLocalDaemonParams(params);
      const protocolLayer = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(Layer.succeed(Socket.Socket, socket)),
      );
      return yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(LocalDaemonRpcs);
        return yield* client.LocalDaemonCall({
          method,
          params: localParams,
        });
      }).pipe(
        Effect.provide(protocolLayer),
        Effect.timeoutFail({
          duration: `${SOCKET_REQUEST_TIMEOUT_MS} millis`,
          onTimeout: () =>
            socketRequestError(method, "Socket request timed out"),
        }),
        Effect.mapError((err) => fromLocalDaemonCallError(method, err)),
      );
    }),
  ).pipe(Effect.withSpan("sendSocketRequest"));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolvedAgentParticipant = {
  readonly type: "agent";
  readonly id: AgentId;
};

const resolvedAgentParticipant = (id: AgentId): ResolvedAgentParticipant => ({
  type: "agent",
  id,
});

/** Resolve "agent:name" or "agent:&lt;uuid>" to { type, id }. */
export const resolveParticipant = (
  raw: string,
): Effect.Effect<ResolvedAgentParticipant, SocketClientError> =>
  Effect.gen(function* () {
    const colon = raw.indexOf(":");
    if (colon === -1) {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Invalid: "${raw}". Use agent:name`,
        }),
      );
    }
    const type = raw.slice(0, colon);
    const value = raw.slice(colon + 1);
    if (type !== "agent") {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Cannot resolve "${raw}"`,
        }),
      );
    }
    if (UUID_RE.test(value)) {
      return resolvedAgentParticipant(value as AgentId);
    }
    const result = yield* request(AgentsLookupByName, {
      names: [value],
    });
    if (result.agents.length === 0) {
      return yield* Effect.fail(
        new ParticipantResolveError({
          input: raw,
          message: `Agent "${value}" not found`,
        }),
      );
    }
    return resolvedAgentParticipant(result.agents[0]!.id);
  }).pipe(Effect.withSpan("resolveParticipant"));
