import { describe, it, expect } from "vitest";
import {
  formatCrossConvOpenClaw,
  CROSS_CONV_HEADER,
} from "./format-cross-conv.js";
import type { CrossConvMessage } from "@moltzap/client";

describe("formatCrossConvOpenClaw", () => {
  it("formats messages as OpenClaw-native JSON metadata blocks", () => {
    const messages: CrossConvMessage[] = [
      {
        conversationId: "conv-dm-1",
        conversationName: undefined,
        senderName: "Seller",
        senderId: "agent-seller",
        text: "My minimum price is $4,000/month.",
        timestamp: "2026-04-13T22:28:00Z",
      },
    ];
    const result = formatCrossConvOpenClaw(messages, {
      ownAgentId: "agent-self",
    });
    expect(result).toContain(CROSS_CONV_HEADER);
    expect(result).toContain('"sender": "Seller"');
    expect(result).toContain('"text": "My minimum price is $4,000/month."');
    expect(result).toContain('"timestamp": "2026-04-13T22:28:00Z"');
  });

  it("replaces own agent ID with 'You' in sender field", () => {
    const messages: CrossConvMessage[] = [
      {
        conversationId: "conv-dm-1",
        senderName: "self-agent",
        senderId: "agent-self",
        text: "Acknowledged.",
        timestamp: "2026-04-13T22:28:05Z",
      },
    ];
    const result = formatCrossConvOpenClaw(messages, {
      ownAgentId: "agent-self",
    });
    expect(result).toContain('"sender": "You"');
  });

  it("preserves chronological order", () => {
    const messages: CrossConvMessage[] = [
      {
        conversationId: "a",
        senderName: "A",
        senderId: "a",
        text: "first",
        timestamp: "2026-04-13T22:00:00Z",
      },
      {
        conversationId: "b",
        senderName: "B",
        senderId: "b",
        text: "second",
        timestamp: "2026-04-13T22:00:01Z",
      },
      {
        conversationId: "a",
        senderName: "A",
        senderId: "a",
        text: "third",
        timestamp: "2026-04-13T22:00:02Z",
      },
    ];
    const result = formatCrossConvOpenClaw(messages, {
      ownAgentId: "agent-self",
    })!;
    const firstIdx = result.indexOf("first");
    const secondIdx = result.indexOf("second");
    const thirdIdx = result.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("returns null for empty messages", () => {
    const result = formatCrossConvOpenClaw([], { ownAgentId: "agent-self" });
    expect(result).toBeNull();
  });

  it("uses conversation name when available, falls back to DM with @sender", () => {
    const messages: CrossConvMessage[] = [
      {
        conversationId: "conv-1",
        conversationName: "Werewolf Den",
        senderName: "Bob",
        senderId: "agent-bob",
        text: "Let's target Alice.",
        timestamp: "2026-04-13T22:00:00Z",
      },
      {
        conversationId: "conv-2",
        conversationName: undefined,
        senderName: "Seller",
        senderId: "agent-seller",
        text: "My price is $4K.",
        timestamp: "2026-04-13T22:00:01Z",
      },
    ];
    const result = formatCrossConvOpenClaw(messages, {
      ownAgentId: "agent-self",
    })!;
    expect(result).toContain('"conversation": "Werewolf Den"');
    expect(result).toContain('"conversation": "DM with @Seller"');
  });
});
