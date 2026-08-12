/** @file Shared channel-adapter primitives for `@moltzap/client/channel-base`. */

// Channel adapters import per-key store primitives through channel-base.
/** Re-exports the public API from `../bounded-map.js`. */
export { BoundedMap } from "../bounded-map.js";

/** Re-exports the public API from `./format-cross-conv.js`. */
export {
  type CrossConvFormatter,
  type CrossConvMarkup,
  formatCrossConv,
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
  type ChannelCoreOptions,
  type ChannelService,
  type ContextBlocks,
  type EnrichedConversationMeta,
  type EnrichedInboundMessage,
  type EnrichedSender,
  type InboundHandler,
  type InboundInterceptDecision,
  type InboundInterceptor,
  MoltZapChannelCore,
} from "../channel-core.js";

/** Re-exports the public API from `../service.js`. */
export {
  type CrossConversationEntry,
  type CrossConvMessage,
  sanitizeForSystemReminder,
} from "../service.js";
