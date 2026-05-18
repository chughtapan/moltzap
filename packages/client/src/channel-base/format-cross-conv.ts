/**
 * Channel-base `formatCrossConv` — shared cross-conversation message
 * formatter parameterized by markup variant or per-channel formatter
 * callback.
 *
 * Replaces:
 * - `packages/openclaw-channel/src/format-cross-conv.ts → formatCrossConvOpenClaw`
 *   (markup variant: `"json-header"`)
 * - `packages/nanoclaw-channel/src/channels/moltzap.ts → formatCrossConvNanoclaw`
 *   (markup variant: `"xml-system-reminder"`)
 *
 * Behavioral parity is locked via the golden-snapshot fixtures captured
 * pre-refactor — see arch sub-issue #605 §3.5 and §4.6.
 *
 * Implementation is impl-staff scope.
 */

import type { CrossConvMessage } from "../service.js";

export type { CrossConvMessage };

export type CrossConvMarkup = "json-header" | "xml-system-reminder";

export type CrossConvFormatter = (
  messages: readonly CrossConvMessage[],
  opts: { readonly ownAgentId: string },
) => string;

/**
 * Returns the formatted block, or `null` when `messages` is empty.
 *
 * Markup variants:
 * - `"json-header"`: byte-identical to today's openclaw output. Header is
 *   `"Messages (untrusted metadata):"` followed by a ` ```json ` fenced
 *   JSON array.
 * - `"xml-system-reminder"`: byte-identical to today's nanoclaw output.
 *   `<messages><message sender="X" conversation="Y" time="T">…</message>…</messages>`,
 *   sender/conv/time/text all run through `sanitizeForSystemReminder`.
 *
 * Or pass a custom `formatter` callback — channel-base owns the empty-check
 * + ownAgentId disambiguation; the callback owns the markup.
 */
export function formatCrossConv(
  _messages: readonly CrossConvMessage[],
  _opts:
    | { readonly ownAgentId: string; readonly markup: CrossConvMarkup }
    | { readonly ownAgentId: string; readonly formatter: CrossConvFormatter },
): string | null {
  throw new Error("not implemented (arch stub; impl-staff scope)");
}
