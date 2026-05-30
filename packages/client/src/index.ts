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
  type ServiceOptions,
  type ServiceRpcError,
} from "./service.js";
export { AgentNotFoundError, MalformedFrameError } from "./runtime/errors.js";
export {
  MoltZapChannelCore,
  type ChannelCoreOptions,
  type ChannelService,
  type ContextBlocks,
  type DispatchAdmissionDecision,
  type DispatchAdmissionRequest,
  type DispatchReleaseFrame,
  type EnrichedConversationMeta,
  type EnrichedInboundMessage,
  type EnrichedSender,
  type InboundHandler,
  type PendingDispatchMessage,
} from "./channel-core.js";
export { MoltZapAgentClient, type AgentClientOptions } from "./agent-client.js";
export {
  MoltZapTMClient,
  type TMClientOptions,
  type TMHandlers,
  type TaskCallbackContext,
  type RpcCallOptions,
} from "./tm-client.js";
export type { CloseInfo } from "./runtime/close-info.js";
// Spec B (#596) — tagged errors for the typed-Stream subscribe surface.
// `NotificationConsumerError` is a type union (see notification/errors.ts
// header for rationale, codex review r1 finding #8).
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
