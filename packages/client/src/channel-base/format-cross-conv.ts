/**
 * @file Shared cross-conversation formatter for channel adapters.
 *
 * `formatCrossConv` is parameterized by a markup variant or per-channel
 * callback. OpenClaw uses `json-header`; NanoClaw uses
 * `xml-system-reminder`. Golden fixtures keep their framing aligned.
 */

import {
  type CrossConvMessage,
  sanitizeForSystemReminder,
} from "../service.js";

/** Re-exports the public API from `current module`. */
export type { CrossConvMessage };

/** Represents cross conv markup values. */
export type CrossConvMarkup = "json-header" | "xml-system-reminder";

/** Represents cross conv formatter values. */
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

/**
 * Format messages from conversations other than the active conversation.
 *
 * Markup variants:
 * - `"json-header"`: openclaw output. Header is
 *   `"Messages (untrusted metadata):"` followed by a fenced JSON array.
 * - `"xml-system-reminder"`: nanoclaw output. `&lt;messages&gt;` wrapper
 *   around `&lt;message&gt;` entries with `sender`/`conversation`/`time`
 *   attributes; sender/conv/time/text all run through
 *   `sanitizeForSystemReminder`.
 *
 * Or pass a custom `formatter` callback — channel-base owns the empty-check
 * + ownAgentId disambiguation; the callback owns the markup.
 * @param messages Messages eligible for cross-conversation rendering.
 * @param opts Markup selection or custom formatter with the current agent id.
 * @returns The formatted block, or `null` when `messages` is empty.
 */
export function formatCrossConv(
  messages: readonly CrossConvMessage[],
  opts:
    | { readonly ownAgentId: string; readonly markup: CrossConvMarkup }
    | { readonly ownAgentId: string; readonly formatter: CrossConvFormatter },
): string | null {
  if (messages.length === 0) {
    return null;
  }
  if ("formatter" in opts) {
    return opts.formatter(messages, { ownAgentId: opts.ownAgentId });
  }
  if (opts.markup === "json-header") {
    return formatJsonHeader(messages, { ownAgentId: opts.ownAgentId });
  }
  return formatXmlSystemReminder(messages, { ownAgentId: opts.ownAgentId });
}

function formatJsonHeader(
  messages: readonly CrossConvMessage[],
  opts: { readonly ownAgentId: string },
): string {
  const items = messages.map((message) => normalizeMessage(message, opts));
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
  const lines = messages.map((message) => {
    const item = normalizeMessage(message, opts);
    const sender = sanitizeForSystemReminder(item.sender);
    const conv = sanitizeForSystemReminder(item.conversation);
    const text = sanitizeForSystemReminder(item.text);
    const time = sanitizeForSystemReminder(item.timestamp);
    return `<message sender="${sender}" conversation="${conv}" time="${time}">${text}</message>`;
  });
  return ["<messages>", ...lines, "</messages>"].join("\n");
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
