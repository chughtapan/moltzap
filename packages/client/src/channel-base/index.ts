/** @file Shared channel-adapter primitives for `@moltzap/client/channel-base`. */

// Channel adapters import per-key store primitives through channel-base.
export { BoundedMap } from "@moltzap/protocol/bounded-map";

export {
  catchLeaseInvalid,
  LeaseAlreadyConsumed,
  type LeaseInvalidProjectionError,
  projectLeaseInvalid,
} from "./lease.js";

export { LeaseStore } from "./lease-store.js";
export { LeaseGuard } from "./lease-guard.js";

export {
  type CrossConvFormatter,
  type CrossConvMarkup,
  formatCrossConv,
} from "./format-cross-conv.js";

export {
  formatGroupBlock,
  getGroupFields,
  type GroupFields,
  type GroupFormatter,
} from "./format-group-block.js";

export {
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
  MoltZapChannelCore,
  type PendingDispatchMessage,
} from "../channel-core.js";

export {
  type CrossConversationEntry,
  type CrossConvMessage,
  sanitizeForSystemReminder,
} from "../service.js";
