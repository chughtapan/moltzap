/* eslint-disable jsdoc/text-escaping, jsdoc/require-description-complete-sentence -- mermaid sequenceDiagram blocks need literal `<br>` and non-sentence labels for renderer compatibility. */

/**
 * @file Shared channel-adapter primitives for `@moltzap/client/channel-base`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host
 *   participant Channel
 *   participant Core as MoltZapChannelCore
 *   participant Server
 *
 *   Host->>Channel: reply / sendMessage
 *   Channel->>Core: sendReply(conv, text, {dispatchLeaseId})
 *   Core->>Server: agent/message/send
 *   Server-->>Core: ForbiddenError data.reason LeaseInvalid
 *   Note over Channel,Core: catchLeaseInvalid reads Clock.currentTimeMillis<br>then projectLeaseInvalid stamps LeaseAlreadyConsumed
 *   Core-->>Channel: Effect.fail(LeaseAlreadyConsumed)
 *   alt claude-code
 *     Channel->>Host: toolErrorResult
 *   else openclaw
 *     Channel->>Host: onLeaseConsumed callback, deliver returns false
 *   else nanoclaw
 *     Channel->>Host: Effect raises LeaseAlreadyConsumed
 *   end
 * ```
 */

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
