/**
 * Unit tests for `event.ts` (meta-key mapping).
 *
 * Transplanted from zapbot `test/claude-channel-event.test.ts` (verdict
 * §(b) MOVE row 3). Tests assert the contract-correct meta keys (`chat_id`,
 * `user`, `message_id`, `ts`) per spec A12.
 */

import { describe, it, expect } from "vitest";
import { Brand } from "effect";
import type { EnrichedInboundMessage } from "@moltzap/client";
import { taskId } from "@moltzap/protocol/testing";
import {
  brandConversationId,
  brandIsoTimestamp,
  brandMessageId,
  brandUserId,
  toClaudeChannelNotification,
} from "./event.js";
import { ContentEmpty, MetaInvalid } from "./errors.js";
import { CLAUDE_CHANNEL_NOTIFICATION_METHOD } from "./types.js";

const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000a1";
const TASK_ID = "00000000-0000-4000-8000-0000000003a1";
const CONVERSATION_OTHER = "00000000-0000-4000-8000-0000000000a2";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000001a1";
const MESSAGE_OTHER = "00000000-0000-4000-8000-0000000001a2";
const AGENT_ALICE = "00000000-0000-4000-8000-0000000002a1";
const AGENT_BOB = "00000000-0000-4000-8000-0000000002a2";
const DEFAULT_TEXT = "hello world";
const PING_TEXT = "ping!";
const INVALID_DATE_TEXT = "not a date";
const VALID_ISO_TIMESTAMP = "2026-04-24T00:00:00Z";
const VALID_ISO_TIMESTAMP_WITH_MS = "2026-04-24T09:00:00.123Z";

// `toClaudeChannelNotification` re-validates `conversationId` at its own
// boundary, so the rejection tests need to inject a raw string the branded
// surface would otherwise forbid. `Brand.nominal` types the literal without
// validating, mirroring the optimistically-typed value the boundary sees.
const rawConversationId =
  Brand.nominal<EnrichedInboundMessage["conversationId"]>();

function makeEvent(
  overrides: Partial<EnrichedInboundMessage> = {},
): EnrichedInboundMessage {
  return {
    id: MESSAGE_ID,
    taskId: taskId(TASK_ID),
    conversationId: brandConversationId(CONVERSATION_ID),
    sender: { id: AGENT_ALICE, name: "Alice" },
    text: DEFAULT_TEXT,
    isFromMe: false,
    createdAt: "2026-04-24T12:00:00.000Z",
    contextBlocks: {},
    ...overrides,
  };
}

describe("toClaudeChannelNotification meta identity", () => {
  it("maps conversationId → chat_id verbatim", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ conversationId: brandConversationId(CONVERSATION_OTHER) }),
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
});

describe("toClaudeChannelNotification content shape", () => {
  it("maps createdAt (ISO string) → ts verbatim", () => {
    const ts = VALID_ISO_TIMESTAMP_WITH_MS;
    const r = toClaudeChannelNotification(makeEvent({ createdAt: ts }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.meta.ts).toBe(ts);
  });

  it("emits method exactly 'notifications/claude/channel'", () => {
    const r = toClaudeChannelNotification(makeEvent());
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.method).toBe(CLAUDE_CHANNEL_NOTIFICATION_METHOD);
  });

  it("passes content through verbatim (no transform)", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: PING_TEXT }));
    expect(r._tag).toBe("Ok");
    if (r._tag !== "Ok") return;
    expect(r.value.params.content).toBe(PING_TEXT);
  });
});

describe("toClaudeChannelNotification invalid content", () => {
  it("rejects with ContentEmpty when text is blank-only", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: "   \n\t" }));
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error).toBeInstanceOf(ContentEmpty);
  });

  it("rejects with ContentEmpty when text is empty string", () => {
    const r = toClaudeChannelNotification(makeEvent({ text: "" }));
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error).toBeInstanceOf(ContentEmpty);
  });
});

describe("toClaudeChannelNotification meta shape", () => {
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
});

describe("toClaudeChannelNotification invalid meta", () => {
  it("rejects with MetaInvalid when conversationId is empty", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ conversationId: rawConversationId("") }),
    );
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error).toBeInstanceOf(MetaInvalid);
  });

  it("rejects with MetaInvalid when createdAt is not ISO", () => {
    const r = toClaudeChannelNotification(
      makeEvent({ createdAt: INVALID_DATE_TEXT }),
    );
    expect(r._tag).toBe("Err");
    if (r._tag !== "Err") return;
    expect(r.error).toBeInstanceOf(MetaInvalid);
  });
});

describe("branded id narrowers", () => {
  it("brandConversationId accepts valid protocol UUID", () => {
    expect(brandConversationId(CONVERSATION_ID)).toBe(CONVERSATION_ID);
  });

  it("brandConversationId rejects invalid non-UUID string", () => {
    expect(() => brandConversationId("abc")).toThrow(/valid conversation id/);
  });

  it("brandConversationId rejects empty string", () => {
    expect(() => brandConversationId("")).toThrow(/non-empty/);
  });
});

describe("branded message narrowers", () => {
  it("brandMessageId rejects whitespace-only", () => {
    expect(() => brandMessageId("   ")).toThrow(/non-empty/);
  });
});

describe("branded user and timestamp narrowers", () => {
  it("brandUserId rejects empty", () => {
    expect(() => brandUserId("")).toThrow(/non-empty/);
  });

  it("brandIsoTimestamp accepts valid ISO", () => {
    expect(brandIsoTimestamp(VALID_ISO_TIMESTAMP)).toBe(VALID_ISO_TIMESTAMP);
  });

  it("brandIsoTimestamp rejects non-ISO strings", () => {
    expect(() => brandIsoTimestamp(INVALID_DATE_TEXT)).toThrow();
  });
});

describe("branded timestamp invalid forms", () => {
  it("brandIsoTimestamp rejects year-only input", () => {
    expect(() => brandIsoTimestamp("2026")).toThrow();
  });
});
