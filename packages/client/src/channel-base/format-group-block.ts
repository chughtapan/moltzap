/**
 * Channel-base group-block helpers.
 *
 * `formatGroupBlock` renders the group block for nanoclaw. The shared
 * type-narrowing predicate `getGroupFields` is consumed by openclaw
 * (deriving `groupSubject` / `groupMembers` for the OpenClaw context) and
 * nanoclaw (gating the group-block render).
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

/**
 * Returns the formatted group block.
 *
 * Markup variants:
 * - `"xml-system-reminder"`: a `&lt;system-reminder&gt;` block with group
 *   name + participants (nanoclaw output).
 * - `"json-header"`: empty string. Openclaw does not render a group block;
 *   it consumes `getGroupFields` directly to derive its OpenClaw-side
 *   `groupSubject` / `groupMembers` fields. The empty-string return makes
 *   "openclaw renders no group block" an explicit, fixtured output.
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
