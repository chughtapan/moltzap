/**
 * `@moltzap/client/channel-base` — shared scaffolding for channel adapters.
 *
 * Used by `@moltzap/openclaw-channel`, `@moltzap/claude-code-channel`, and
 * `@moltzap/nanoclaw-channel` to canonicalize:
 * - the `LeaseAlreadyConsumed` tagged error class (one definition site)
 * - the `projectLeaseInvalid` + `catchLeaseInvalid` wire-error projection
 * - the `LeaseStore<HostKey, T>` and `LeaseGuard` lease lifecycle primitives
 * - the `formatCrossConv` + `formatGroupBlock` + `getGroupFields` formatters
 *   (parameterized by markup variant or per-channel callback)
 *
 * Detail doc: `packages/client/docs/architecture/08-channel-base.md`.
 * Spec: #597. Architect plan: #605.
 *
 * NOTE — this subpath is opt-in. Direct `@moltzap/client` consumers
 * (server-core, runtimes, test-utils) see no API-surface change.
 */

export {
  LeaseAlreadyConsumed,
  projectLeaseInvalid,
  catchLeaseInvalid,
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

// Re-exports for ergonomics on the subpath (these are part of the public
// `@moltzap/client` barrel already; channel-base callers shouldn't need to
// import from two paths to use the formatters).
export {
  sanitizeForSystemReminder,
  type CrossConvMessage,
} from "../service.js";
export { type EnrichedConversationMeta } from "../channel-core.js";
