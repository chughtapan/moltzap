/** @file Shared channel-adapter primitives for `@moltzap/client/channel-base`. */

// Channel adapters import per-key store primitives through channel-base.
/** Re-exports the public API from `../bounded-map.js`. */
export { BoundedMap } from "../bounded-map.js";

/** Re-exports the public API from `./lease.js`. */
export {
  LeaseAlreadyConsumed,
  projectLeaseInvalid,
  catchLeaseInvalid,
  type LeaseInvalidProjectionError,
} from "./lease.js";

/** Re-exports the public API from `./lease-store.js`. */
export { LeaseStore } from "./lease-store.js";
/** Re-exports the public API from `./lease-guard.js`. */
export { LeaseGuard } from "./lease-guard.js";

/** Re-exports the public API from `./format-cross-conv.js`. */
export {
  formatCrossConv,
  type CrossConvFormatter,
  type CrossConvMarkup,
} from "./format-cross-conv.js";

/** Re-exports the public API from `./format-group-block.js`. */
export {
  formatGroupBlock,
  getGroupFields,
  type GroupFields,
  type GroupFormatter,
} from "./format-group-block.js";

/** Re-exports the public API from `../channel-core.js`. */
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

/** Re-exports the public API from `../service.js`. */
export {
  sanitizeForSystemReminder,
  type CrossConversationEntry,
  type CrossConvMessage,
} from "../service.js";
