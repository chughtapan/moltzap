/**
 * @file Public barrel for the MoltZap client package.
 */
export {
  MoltZapService,
  formatCrossConversationBlock,
  sanitizeForSystemReminder,
  type ConversationMeta,
  type ContextOptions,
  type CrossConvMessage,
  type CrossConversationEntry,
  type ServiceRpcError,
} from "./service.js";
export { AgentNotFoundError } from "@moltzap/protocol/identity";
export { MoltZapAgentClient, type AgentClientOptions } from "./agent-client.js";
export {
  MoltZapAppClient,
  type AppClientOptions,
  type AppCallbackContext,
  type RpcCallOptions,
} from "./app-client.js";
export type { AppCallbackHandlers } from "@moltzap/protocol/socket";
// Tagged errors for the typed-Stream subscribe surface.
// `NotificationConsumerError` is a type union (see notification/errors.ts
// header for rationale).
export {
  NotificationTimeoutError,
  StreamClosedError as NotificationStreamClosedError,
  type StreamCloseReason,
  type NotificationConsumerError,
} from "./notification/errors.js";
export {
  registerAgent,
  type RegisterAgentOptions,
  type RegisterResponse,
} from "./auth.js";
// Generic drainer for the cursor-paginated list RPCs (shared across
// channels/CLIs that need the complete result set, not just one page).
export {
  drainPaginatedList,
  NonAdvancingCursorError,
  type SendRpcFn,
} from "./pagination.js";
