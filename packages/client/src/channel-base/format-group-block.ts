/**
 * Channel-base group-block helpers.
 *
 * Replaces nanoclaw's inline `formatGroupBlock` at
 * `packages/nanoclaw-channel/src/channels/moltzap.ts → formatGroupBlock`. Also
 * extracts the shared type-narrowing predicate (`getGroupFields`) consumed by
 * openclaw (deriving `groupSubject` / `groupMembers` for the OpenClaw context),
 * nanoclaw (gating the inline group-block render), and claude-code (the
 * consistent type-narrowed predicate even though claude-code drops context).
 *
 * Implementation is impl-staff scope.
 */

import type { EnrichedConversationMeta } from "../channel-core.js";
import type { CrossConvMarkup } from "./format-cross-conv.js";

export interface GroupFields {
  readonly name: string | undefined;
  readonly participants: readonly string[];
}

export type GroupFormatter = (fields: GroupFields) => string;

/**
 * Returns `{ name, participants }` when `meta?.type === "group"`; else `null`.
 * Pure narrowing helper — callers use the non-null return to drive
 * `formatGroupBlock` or per-channel field extraction.
 */
export function getGroupFields(
  _meta: EnrichedConversationMeta | undefined,
): GroupFields | null {
  throw new Error("not implemented (arch stub; impl-staff scope)");
}

/**
 * Returns the formatted group block.
 *
 * Markup variants:
 * - `"xml-system-reminder"`: byte-identical to today's nanoclaw output
 *   (a `<system-reminder>` block with group name + participants).
 * - `"json-header"`: empty string. Openclaw does not render a group block;
 *   it consumes `getGroupFields` directly to derive its OpenClaw-side
 *   `groupSubject` / `groupMembers` fields. The empty-string return locks
 *   that "openclaw renders no group block" behavior as an explicit,
 *   fixtured output (see arch sub-issue #605 §3.5).
 *
 * Or pass a custom `formatter` callback.
 */
export function formatGroupBlock(
  _fields: GroupFields,
  _opts:
    | { readonly markup: CrossConvMarkup }
    | { readonly formatter: GroupFormatter },
): string {
  throw new Error("not implemented (arch stub; impl-staff scope)");
}
