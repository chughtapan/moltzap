/**
 * @file `@moltzap/client/channel-base` — shared scaffolding for channel
 * adapters (`@moltzap/openclaw-channel`, `@moltzap/claude-code-channel`,
 * `@moltzap/nanoclaw-channel`).
 *
 * The subpath canonicalizes three things across the three channels:
 * (1) the `LeaseAlreadyConsumed` tagged error and its projection
 * helpers, (2) the lease-lifecycle primitives (`LeaseStore` /
 * `LeaseGuard`), and (3) the markup-parameterized cross-conv and
 * group-block formatters. Direct `@moltzap/client` consumers
 * (`server-core`, `runtimes`, `test-utils`) see no API surface
 * change — the subpath is opt-in.
 *
 * Surfacing path differs per host contract:
 *
 * - **claude-code** — raises via `server.ts → toolErrorResult`.
 * - **openclaw** — invokes the optional `onLeaseConsumed` side-channel callback (deliver's wire return type is `PromiseLike&lt;boolean>` and cannot carry an Effect error).
 * - **nanoclaw** — raises the typed error on the Effect channel.
 *
 * Common lease-projection path:
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Host
 *   participant Channel
 *   participant Core as MoltZapChannelCore
 *   participant Server.
 *
 *   Host->>Channel: reply / sendMessage
 *   Channel->>Core: sendReply(conv, text, {dispatchLeaseId})
 *   Core->>Server: messages/send
 *   Server-->>Core: ForbiddenError data.reason LeaseInvalid
 *   Note over Channel,Core: catchLeaseInvalid reads Clock.currentTimeMillis&lt;br>then projectLeaseInvalid stamps LeaseAlreadyConsumed
 *   Core-->>Channel: Effect.fail(LeaseAlreadyConsumed)
 *   alt claude-code
 *     Channel->>Host: toolErrorResult
 *   else openclaw
 *     Channel->>Host: onLeaseConsumed callback, deliver returns false
 *   else nanoclaw
 *     Channel->>Host: Effect raises LeaseAlreadyConsumed
 *   end
 * ```
 *
 * The `_tag === "LeaseAlreadyConsumed"` forward-compat arm of
 * `projectLeaseInvalid` covers a future server that emits the
 * canonical tag in `data` directly; no channel-side change required.
 *
 * Primitives live one-per-file:
 *
 * - `lease.ts` — `LeaseAlreadyConsumed`, `projectLeaseInvalid`, `catchLeaseInvalid` (Effect-pipe wrapper at every `core.sendReply(...)` boundary).
 * - `lease-store.ts` — `LeaseStore&lt;HostKey, T>`: per-key tracker with `remember` / `peek` / `consume` / `clear`. Nanoclaw stores `(jid, dispatchLeaseId)` and `peek`s deliberately on retries so the server returns CONSUMED rather than accepting a duplicate send.
 * - `lease-guard.ts` — `LeaseGuard`: single-shot dup-reply detector scoped to one inbound message. `consume()` returns `true` exactly once.
 * - `format-cross-conv.ts` — markup-parameterized formatter (`json-header` for openclaw, `xml-system-reminder` for nanoclaw). Owns empty-check and own-agent disambiguation; markup ownership lives in the variant table.
 * - `format-group-block.ts` — `formatGroupBlock` + `getGroupFields` predicate. Openclaw consumes the narrowed fields directly; nanoclaw renders via the `xml-system-reminder` variant.
 *
 * No high-level `createChannelBase(opts)` helper: channels diverge
 * on surfacing and markup. A facade would either hard-code one
 * surfacing path or accept callbacks for each, ending up a thin
 * wrapper over the primitives below.
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

// Re-exports for ergonomics on the subpath (these are part of the public
// `@moltzap/client` barrel already; channel-base callers shouldn't need to
// import from two paths to use the formatters).
export {
  sanitizeForSystemReminder,
  type CrossConvMessage,
} from "../service.js";
export { type EnrichedConversationMeta } from "../channel-core.js";
