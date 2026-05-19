/**
 * Channel-base group-block helpers.
 *
 * Replaces nanoclaw's inline `formatGroupBlock` at
 * `packages/nanoclaw-channel/src/channels/moltzap.ts → formatGroupBlock`. Also
 * extracts the shared type-narrowing predicate (`getGroupFields`) consumed by
 * openclaw (deriving `groupSubject` / `groupMembers` for the OpenClaw context)
 * and nanoclaw (gating the inline group-block render).
 */

import { sanitizeForSystemReminder } from "../service.js";
import type { EnrichedConversationMeta } from "../channel-core.js";
import type { CrossConvMarkup } from "./format-cross-conv.js";

export interface GroupFields {
  readonly name: string | undefined;
  readonly participants: readonly string[];
}

export type GroupFormatter = (fields: GroupFields) => string;

const UNNAMED_GROUP_FALLBACK = "(unnamed)";
const NO_PARTICIPANTS_FALLBACK = "(none listed)";

/**
 * Returns `{ name, participants }` when `meta?.type === "group"`; else `null`.
 * Pure narrowing helper — callers use the non-null return to drive
 * `formatGroupBlock` or per-channel field extraction (openclaw's
 * `groupSubject` + `groupMembers`).
 */
export function getGroupFields(
  meta: EnrichedConversationMeta | undefined,
): GroupFields | null {
  if (meta?.type !== "group") return null;
  return { name: meta.name, participants: meta.participants };
}

function formatXmlSystemReminder(fields: GroupFields): string {
  const safeName = sanitizeForSystemReminder(
    fields.name ?? UNNAMED_GROUP_FALLBACK,
  );
  const safeParticipants = fields.participants.map(sanitizeForSystemReminder);
  return [
    "<system-reminder>",
    "This is a group conversation.",
    `Group name: ${safeName}`,
    `Participants (${fields.participants.length}): ${safeParticipants.join(", ") || NO_PARTICIPANTS_FALLBACK}`,
    "</system-reminder>",
  ].join("\n");
}

/**
 * Returns the formatted group block.
 *
 * Markup variants:
 * - `"xml-system-reminder"`: byte-identical to the pre-refactor nanoclaw
 *   output (a `&lt;system-reminder&gt;` block with group name + participants).
 * - `"json-header"`: empty string. Openclaw does not render a group block;
 *   it consumes `getGroupFields` directly to derive its OpenClaw-side
 *   `groupSubject` / `groupMembers` fields. The empty-string return locks
 *   the "openclaw renders no group block" behavior as an explicit,
 *   fixtured output (see arch sub-issue #605 §3.5).
 *
 * Or pass a custom `formatter` callback.
 */
export function formatGroupBlock(
  fields: GroupFields,
  opts:
    | { readonly markup: CrossConvMarkup }
    | { readonly formatter: GroupFormatter },
): string {
  if ("formatter" in opts) return opts.formatter(fields);
  switch (opts.markup) {
    case "xml-system-reminder":
      return formatXmlSystemReminder(fields);
    case "json-header":
      return "";
  }
}
