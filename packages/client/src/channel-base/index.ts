/** @file Shared channel-adapter primitives for `@moltzap/client/channel-base`. */

// Channel adapters import per-key store primitives through channel-base.
export { BoundedMap } from "@moltzap/protocol/bounded-map";

export {
  LeaseAlreadyConsumed,
  projectLeaseInvalid,
  catchLeaseInvalid,
  type LeaseInvalidProjectionError,
} from "./lease.js";

export { LeaseStore } from "./lease-store.js";
export { LeaseGuard } from "./lease-guard.js";

export {
  formatCrossConv,
  type CrossConvFormatter,
  type CrossConvMarkup,
} from "./format-cross-conv.js";

export {
  formatGroupBlock,
  getGroupFields,
  type GroupFields,
  type GroupFormatter,
} from "./format-group-block.js";

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
} from "../channel-core.js";

export {
  sanitizeForSystemReminder,
  type CrossConversationEntry,
  type CrossConvMessage,
} from "../service.js";
