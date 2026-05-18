import { Effect } from "effect";
import {
  LocalServiceCommands,
  request as socketRpcRequest,
  requestLocalService,
  sendSocketRequest,
} from "../../cli/socket-client.js";
import type {
  HistoryRequestInput,
  HistoryResponse,
} from "../../runtime/local-history.js";
import { SOCKET_HISTORY_LIMIT } from "./constants.js";

export type SocketHistoryResponse = HistoryResponse;

export const socketRequest = (
  method: string,
  params?: Record<string, unknown>,
  socketPath?: string,
) => {
  const resolvedParams = params ?? {};
  if (socketPath === undefined) {
    return sendSocketRequest(method, resolvedParams);
  }
  return sendSocketRequest(method, resolvedParams, socketPath);
};

export const socketHistory = (
  conversationId: string,
  sessionKey?: string,
  limit = SOCKET_HISTORY_LIMIT,
): Effect.Effect<SocketHistoryResponse, unknown> => {
  const params: HistoryRequestInput =
    sessionKey === undefined
      ? {
          conversationId,
          limit,
        }
      : {
          conversationId,
          sessionKey,
          limit,
        };
  return requestLocalService(LocalServiceCommands.History, params).pipe(
    Effect.withSpan("socketHistory"),
  );
};

export { LocalServiceCommands, requestLocalService, socketRpcRequest };
