/**
 * @file Shared helpers for client service integration tests.
 */
export {
  closeClients,
  connectClients,
  connectService,
  createDm,
  registerAgent,
  sendAndSettle,
} from "./agents.js";
export {
  ARCHIVED_MESSAGE,
  B_UPDATE,
  CONTEXT_LIMIT,
  FIRST_MESSAGE,
  FROM_C,
  FROM_D,
  HELLO_FROM_C,
  HELLO_FROM_SERVICE,
  HELLO_RECEIVER,
  HISTORY_FIRST_BUFFER_MESSAGE,
  HISTORY_LAST_BUFFER_MESSAGE,
  HISTORY_MESSAGE_COUNT,
  HISTORY_PARTICIPANT_COUNT,
  HISTORY_SETTLE_MS,
  IMAGE_MARKER,
  INTEGRATION_HOOK_TIMEOUT_MS,
  LONG_MESSAGE_LENGTH,
  MESSAGE_SETTLE_MS,
  NEW_MESSAGE,
  NOTIFICATION_WAIT_MS,
  ONE_NEW_MARKER,
  PEEK_FROM_C,
  PRICE_MESSAGE,
  RESOLVED_AGENT_CONTEXT_NAME,
  SECOND_MESSAGE,
  SERVICE_NAME_TEST,
  SHARED_UPDATE,
  SOCKET_HISTORY_LIMIT,
  SOCKET_PAGE_MESSAGE_COUNT,
  SOCKET_RESPONSE_TIMEOUT_MS,
  SOCK_HIST_B_NAME,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  TRACK_NEW_MESSAGE,
  TRACK_SESSION_KEY,
} from "./constants.js";
export { textContent } from "./messages.js";
export { coreBaseUrl, coreWsUrl, setupServiceIntegration } from "./server.js";
export {
  LocalDaemonCommands,
  requestDaemonCommand,
  socketHistory,
} from "./socket.js";
export type { SocketHistoryResponse } from "./socket.js";

export {
  ConversationArchivedError,
  TaskConversationArchive,
  TaskConversationList,
} from "@moltzap/protocol/conversation";
export { DEFAULT_APP_ID, TaskLeave, TaskRequest } from "@moltzap/protocol/task";
export {
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol/message";
