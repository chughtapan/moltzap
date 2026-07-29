import { Effect } from "effect";
import {
  LocalDaemonCommands,
  requestDaemonCommand,
} from "../../cli/socket-client.js";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import type { HistoryRequest, HistoryResponse } from "../../local-history.js";
import { SOCKET_HISTORY_LIMIT } from "./constants.js";

export type SocketHistoryResponse = HistoryResponse;

export const socketHistory = (
  taskId: TaskId,
  conversationId: ConversationId,
  sessionKey?: string,
  limit = SOCKET_HISTORY_LIMIT,
): Effect.Effect<SocketHistoryResponse, unknown> => {
  const params: HistoryRequest =
    sessionKey === undefined
      ? {
          taskId,
          conversationId,
          limit,
        }
      : {
          taskId,
          conversationId,
          sessionKey,
          limit,
        };
  return requestDaemonCommand(LocalDaemonCommands.history, params).pipe(
    Effect.withSpan("socketHistory"),
  );
};

export { LocalDaemonCommands, requestDaemonCommand };
