import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";

const TOTAL_MESSAGES_TO_SEND = 15;
const PAGE_SIZE = 10;
const FIRST_PAGE_FIRST_TEXT = "Message 6";
const FIRST_PAGE_LAST_TEXT = "Message 15";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("message listing returns messages in ascending order with hasMore", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    // Send enough messages to require pagination.
    for (let i = 1; i <= TOTAL_MESSAGES_TO_SEND; i++) {
      yield* alice.client.sendRpc(MessagesSend, {
        conversationId,
        parts: [{ type: "text", text: `Message ${i}` }],
      });
    }

    // List with limit=10 — should get newest 10 and hasMore=true
    const page1 = (yield* alice.client.sendRpc(MessagesList, {
      conversationId,
      limit: PAGE_SIZE,
    })) as {
      messages: Array<{
        id: string;
        senderId: string;
        parts: Array<{ text: string }>;
      }>;
      hasMore: boolean;
    };
    expect(page1.messages).toHaveLength(PAGE_SIZE);
    expect(page1.hasMore).toBe(true);

    // Messages are returned in ascending order (oldest first in page)
    const texts = page1.messages.map((m) => m.parts[0]!.text);
    // Newest 10 = Message 6 through Message 15
    expect(texts[0]).toBe(FIRST_PAGE_FIRST_TEXT);
    expect(texts.at(-1)).toBe(FIRST_PAGE_LAST_TEXT);

    // All messages have createdBy set to alice's agent ID
    for (const m of page1.messages) {
      expect(m.senderId).toBe(alice.agentId);
    }

    // No duplicate IDs
    const ids = page1.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(PAGE_SIZE);

    // List all — should get every message.
    const all = (yield* alice.client.sendRpc(MessagesList, {
      conversationId,
      limit: 100,
    })) as {
      messages: Array<{ id: string; parts: Array<{ text: string }> }>;
      hasMore: boolean;
    };
    expect(all.messages).toHaveLength(TOTAL_MESSAGES_TO_SEND);
    expect(all.hasMore).toBe(false);
  }));
