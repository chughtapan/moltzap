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
export type { PermissionsRequiredEvent } from "@moltzap/protocol";
export {
  AgentNotFoundError,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
  MalformedFrameError,
} from "./runtime/errors.js";
export {
  MoltZapChannelCore,
  type ChannelCoreOptions,
  type ChannelService,
  type ContextBlocks,
  type EnrichedConversationMeta,
  type EnrichedInboundMessage,
  type EnrichedSender,
  type InboundHandler,
} from "./channel-core.js";
export {
  MoltZapWsClient,
  type WsClientLogger,
  type MoltZapWsClientOptions,
  type TrackedRpcResponse,
} from "./ws-client.js";
export type {
  SubscriptionFilter,
  SubscriptionId,
  EventSubscription,
  SubscriberHandler,
} from "./runtime/subscribers.js";
export type { CloseInfo } from "./runtime/close-info.js";
