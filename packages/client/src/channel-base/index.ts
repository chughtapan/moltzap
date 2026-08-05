/** @file Shared channel-adapter primitives for `@moltzap/client/channel-base`. */

// Channel adapters import per-key store primitives through channel-base.
/** Re-exports the public API from `../bounded-map.js`. */
export { BoundedMap } from "../bounded-map.js";

/** Re-exports the public API from `./format-cross-conv.js`. */
export { formatCrossConv } from "./format-cross-conv.js";

/** Re-exports the public API from `./format-group-block.js`. */
export {
  formatGroupBlock,
  getGroupFields,
  type GroupFields,
} from "./format-group-block.js";

// Presentation shapes only. `MoltZapChannelCore` and `ChannelService` are
// daemon-side machinery: an adapter that reached them would be building its own
// transport instead of talking to one through HarnessClient.
/** Re-exports the public API from `../channel-core.js`. */
export { type EnrichedConversationMeta } from "../channel-core.js";

/** Re-exports the public API from `../service.js`. */
export { type CrossConvMessage } from "../service.js";
