import { Effect } from "effect";
import {
  localDaemonCommands,
  requestDaemonCommand,
} from "../../cli/socket-client.js";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { HistoryRequest, HistoryResponse } from "../../local-history.js";
import { SOCKET_HISTORY_LIMIT } from "./constants.js";

/** Represents socket history response values. */
export type SocketHistoryResponse = HistoryResponse;

/**
 * Provides the socket history runtime value.
 * @param conversationId Value supplied to the operation.
 * @param sessionKey Value supplied to the operation.
 * @param limit Value supplied to the operation.
 * @returns The socket history result.
 */
export const socketHistory = (
  conversationId: ConversationId,
  sessionKey?: string,
  limit = SOCKET_HISTORY_LIMIT,
): Effect.Effect<SocketHistoryResponse, unknown> => {
  const params: HistoryRequest =
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
  return requestDaemonCommand(localDaemonCommands.history, params).pipe(
    Effect.withSpan("socketHistory"),
  );
};

/** Re-exports the public API from `current module`. */
export { localDaemonCommands, requestDaemonCommand };
