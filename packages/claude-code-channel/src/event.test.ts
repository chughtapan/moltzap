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
  brandConversationId,
  brandIsoTimestamp,
  brandMessageId,
  brandUserId,
  toClaudeChannelNotification,
} from "./event.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000a1";
const CONVERSATION_OTHER = "00000000-0000-4000-8000-0000000000a2";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000001a1";
const MESSAGE_OTHER = "00000000-0000-4000-8000-0000000001a2";
const AGENT_ALICE = "00000000-0000-4000-8000-0000000002a1";
const AGENT_BOB = "00000000-0000-4000-8000-0000000002a2";

function makeEvent(
  overrides: Partial<EnrichedInboundMessage> = {},
): EnrichedInboundMessage {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    sender: { id: AGENT_ALICE, name: "Alice" },
    text: "hello world",
    isFromMe: false,
    createdAt: "2026-04-24T12:00:00.000Z",
    contextBlocks: {},
    ...overrides,
  };
}

describe("toClaudeChannelNotification — meta-key mapping (spec A5, A12)", () => {
  it("maps conversationId → chat_id verbatim", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ conversationId: CONVERSATION_OTHER }),
    );
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.chat_id).toBe(CONVERSATION_OTHER);
  });

  it("maps sender.id → user verbatim", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ sender: { id: AGENT_BOB, name: "Bob" } }),
    );
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.user).toBe(AGENT_BOB);
  });

  it("maps inbound .id → message_id verbatim", () => {
    const r = toClaudeChannelNotification(makeEvent({ id: MESSAGE_OTHER }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.message_id).toBe(MESSAGE_OTHER);
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
    const meta = r.value.params.meta;
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
  it("brandConversationId accepts valid protocol UUID", () => {
    expect(brandConversationId(CONVERSATION_ID)).toBe(CONVERSATION_ID);
  });

  it("brandConversationId rejects invalid non-UUID string", () => {
    expect(() => brandConversationId("abc")).toThrow(/valid conversation id/);
  });

  it("brandConversationId rejects empty string", () => {
    expect(() => brandConversationId("")).toThrow(/non-empty/);
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
