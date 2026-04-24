/**
 * Unit tests for `event.ts` (meta-key mapping).
 *
 * Transplanted from zapbot `test/claude-channel-event.test.ts` (verdict
 * §(b) MOVE row 3). Tests assert the contract-correct meta keys (`chat_id`,
 * `user`, `message_id`, `ts`) per spec A12.
 */

import { describe, it, expect } from "vitest";
import type { EnrichedInboundMessage } from "@moltzap/client";
import {
  brandChatId,
  brandIsoTimestamp,
  brandMessageId,
  brandUserId,
  toClaudeChannelNotification,
} from "./event.js";

function makeEvent(
  overrides: Partial<EnrichedInboundMessage> = {},
): EnrichedInboundMessage {
  return {
    id: "msg-01",
    conversationId: "conv-01",
    sender: { id: "agent-alice", name: "Alice" },
    text: "hello world",
    isFromMe: false,
    createdAt: "2026-04-24T12:00:00.000Z",
    contextBlocks: {},
    ...overrides,
  };
}

describe("toClaudeChannelNotification — meta-key mapping (spec A5, A12)", () => {
  it("maps conversationId → chat_id verbatim", () => {
    const r = toClaudeChannelNotification(makeEvent({ conversationId: "C42" }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.chat_id).toBe("C42");
  });

  it("maps sender.id → user verbatim", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ sender: { id: "agent-bob", name: "Bob" } }),
    );
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.user).toBe("agent-bob");
  });

  it("maps inbound .id → message_id verbatim", () => {
    const r = toClaudeChannelNotification(makeEvent({ id: "M-42" }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.message_id).toBe("M-42");
  });

  it("maps createdAt (ISO string) → ts verbatim", () => {
    const ts = "2026-04-24T09:00:00.123Z";
    const r = toClaudeChannelNotification(makeEvent({ createdAt: ts }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.ts).toBe(ts);
  });

  it("emits method exactly 'notifications/claude/channel'", () => {
    const r = toClaudeChannelNotification(makeEvent());
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.method).toBe("notifications/claude/channel");
  });

  it("passes content through verbatim (no transform)", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: "ping!" }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.content).toBe("ping!");
  });

  it("rejects with ContentEmpty when text is blank-only", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: "   \n\t" }));
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error._tag).toBe("ContentEmpty");
  });

  it("rejects with ContentEmpty when text is empty string", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: "" }));
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error._tag).toBe("ContentEmpty");
  });

  it("omits file_path key in v1", () => {
    const r = toClaudeChannelNotification(makeEvent());
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect("file_path" in r.value.params.meta).toBe(false);
  });

  it("does not emit zapbot's invented keys (conversation_id, sender_id, received_at_ms)", () => {
    const r = toClaudeChannelNotification(makeEvent());
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    const meta = r.value.params.meta as unknown as Record<string, unknown>;
    expect("conversation_id" in meta).toBe(false);
    expect("sender_id" in meta).toBe(false);
    expect("received_at_ms" in meta).toBe(false);
  });

  it("rejects with MetaInvalid when conversationId is empty", () => {
    const r = toClaudeChannelNotification(makeEvent({ conversationId: "" }));
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error._tag).toBe("MetaInvalid");
  });

  it("rejects with MetaInvalid when createdAt is not ISO", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ createdAt: "not a date" }),
    );
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error._tag).toBe("MetaInvalid");
  });
});

describe("branded-type narrowers (Principle 1)", () => {
  it("brandChatId accepts non-empty string", () => {
    expect(brandChatId("abc")).toBe("abc");
  });

  it("brandChatId rejects empty string", () => {
    expect(() => brandChatId("")).toThrow(/non-empty/);
  });

  it("brandMessageId rejects whitespace-only", () => {
    expect(() => brandMessageId("   ")).toThrow(/non-empty/);
  });

  it("brandUserId rejects empty", () => {
    expect(() => brandUserId("")).toThrow(/non-empty/);
  });

  it("brandIsoTimestamp accepts valid ISO", () => {
    expect(brandIsoTimestamp("2026-04-24T00:00:00Z")).toBe(
      "2026-04-24T00:00:00Z",
    );
  });

  it("brandIsoTimestamp rejects non-ISO strings", () => {
    expect(() => brandIsoTimestamp("not-a-date")).toThrow();
  });

  it("brandIsoTimestamp rejects year-only input", () => {
    expect(() => brandIsoTimestamp("2026")).toThrow();
  });
});
