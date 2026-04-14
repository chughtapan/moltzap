/**
 * OpenClaw-native cross-conversation formatter.
 *
 * Formats CrossConvMessage[] as a JSON metadata block with the
 * "(untrusted metadata)" header that OpenClaw agents expect.
 */

import type { CrossConvMessage } from "@moltzap/client";

export type { CrossConvMessage };

export const CROSS_CONV_HEADER = "Messages (untrusted metadata):";

export function formatCrossConvOpenClaw(
  messages: CrossConvMessage[],
  opts: { ownAgentId: string },
): string | null {
  if (messages.length === 0) return null;

  const items = messages.map((m) => ({
    conversation: m.conversationName ?? `DM with @${m.senderName}`,
    sender: m.senderId === opts.ownAgentId ? "You" : m.senderName,
    text: m.text,
    timestamp: m.timestamp,
  }));

  return `${CROSS_CONV_HEADER}\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\``;
}
