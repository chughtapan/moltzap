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
export {
  MoltZapWsClient,
  type MoltZapWsClientOptions,
  type AppCallbackHandlers,
  type TaskCallbackContext,
  type RpcCallOptions,
} from "./ws-client.js";
export type { CloseInfo } from "./runtime/close-info.js";
// Spec B (#596) — tagged errors for the typed-Stream subscribe surface.
// `NotificationConsumerError` is a type union (see notification/errors.ts
// header for rationale, codex review r1 finding #8).
export {
  TimeoutError as NotificationTimeoutError,
  StreamClosedError as NotificationStreamClosedError,
  type NotificationConsumerError,
} from "./notification/errors.js";
export {
  registerAgent,
  type RegisterAgentOptions,
  type RegisterResponse,
} from "./auth.js";
