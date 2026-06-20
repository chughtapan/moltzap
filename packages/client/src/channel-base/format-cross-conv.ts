/**
 * Channel-base `formatCrossConv` — shared cross-conversation message
 * formatter parameterized by markup variant or per-channel formatter
 * callback.
 *
 * Used by the openclaw channel (markup variant `"json-header"`) and the
 * nanoclaw channel (markup variant `"xml-system-reminder"`). Behavioral
 * parity across both is locked via golden-snapshot fixtures.
 */

import {
  type CrossConvMessage,
  sanitizeForSystemReminder,
} from "../service.js";

export type { CrossConvMessage };

export type CrossConvMarkup = "json-header" | "xml-system-reminder";

export type CrossConvFormatter = (
  messages: readonly CrossConvMessage[],
  opts: { readonly ownAgentId: string },
) => string;

const CROSS_CONV_HEADER_JSON = "Messages (untrusted metadata):";
const JSON_INDENT_SPACES = 2;

interface NormalizedItem {
  readonly conversation: string;
  readonly sender: string;
  readonly text: string;
  readonly timestamp: string;
}

function normalizeMessage(
  message: CrossConvMessage,
  opts: { readonly ownAgentId: string },
): NormalizedItem {
  return {
    conversation: message.conversationName ?? `DM with @${message.senderName}`,
    sender: message.senderId === opts.ownAgentId ? "You" : message.senderName,
    text: message.text,
    timestamp: message.timestamp,
  };
}

function formatJsonHeader(
  messages: readonly CrossConvMessage[],
  opts: { readonly ownAgentId: string },
): string {
  const items = messages.map((m) => normalizeMessage(m, opts));
  return `${CROSS_CONV_HEADER_JSON}\n\`\`\`json\n${JSON.stringify(
    items,
    null,
    JSON_INDENT_SPACES,
  )}\n\`\`\``;
}

function formatXmlSystemReminder(
  messages: readonly CrossConvMessage[],
  opts: { readonly ownAgentId: string },
): string {
  const lines = messages.map((m) => {
    const item = normalizeMessage(m, opts);
    const sender = sanitizeForSystemReminder(item.sender);
    const conv = sanitizeForSystemReminder(item.conversation);
    const text = sanitizeForSystemReminder(item.text);
    const time = sanitizeForSystemReminder(item.timestamp);
    return `<message sender="${sender}" conversation="${conv}" time="${time}">${text}</message>`;
  });
  return ["<messages>", ...lines, "</messages>"].join("\n");
}

/**
 * Returns the formatted block, or `null` when `messages` is empty.
 *
 * Markup variants:
 * - `"json-header"`: openclaw output. Header is
 *   `"Messages (untrusted metadata):"` followed by a ` ```json ` fenced
 *   JSON array.
 * - `"xml-system-reminder"`: nanoclaw output. `&lt;messages&gt;` wrapper
 *   around `&lt;message&gt;` entries with `sender`/`conversation`/`time`
 *   attributes; sender/conv/time/text all run through
 *   `sanitizeForSystemReminder`.
 *
 * Or pass a custom `formatter` callback — channel-base owns the empty-check
 * + ownAgentId disambiguation; the callback owns the markup.
 */
export function formatCrossConv(
  messages: readonly CrossConvMessage[],
  opts:
    | { readonly ownAgentId: string; readonly markup: CrossConvMarkup }
    | { readonly ownAgentId: string; readonly formatter: CrossConvFormatter },
): string | null {
  if (messages.length === 0) return null;
  if ("formatter" in opts) {
    return opts.formatter(messages, { ownAgentId: opts.ownAgentId });
  }
  switch (opts.markup) {
    case "json-header":
      return formatJsonHeader(messages, { ownAgentId: opts.ownAgentId });
    case "xml-system-reminder":
      return formatXmlSystemReminder(messages, { ownAgentId: opts.ownAgentId });
  }
}
