import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import { agentConversationCreate } from "@moltzap/protocol/conversation";
import { messagesList, messagesSend } from "@moltzap/protocol/message";

const TOTAL_MESSAGES_TO_SEND = 15;
const PAGE_SIZE = 10;
const FIRST_PAGE_FIRST_TEXT = "Message 6";
const FIRST_PAGE_LAST_TEXT = "Message 15";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("message listing returns bounded newest messages in ascending order", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });
    const conversationId = conv.conversation.id;

    // Send enough messages to exceed the bounded result window.
    for (let i = 1; i <= TOTAL_MESSAGES_TO_SEND; i++) {
      yield* alice.client.sendRpc(messagesSend, {
        conversationId,
        parts: [{ type: "text", text: `Message ${i}` }],
      });
    }

    // List with limit=10 — should get the newest 10.
    const page1 = yield* alice.client.sendRpc(messagesList, {
      conversationId,
      limit: PAGE_SIZE,
    });
    expect(page1.messages).toHaveLength(PAGE_SIZE);

    // Messages are returned in ascending order (oldest first in page)
    const texts = page1.messages.map((m) => {
      const part = m.parts[0];
      return part.type === "text" ? part.text : "";
    });
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
    const all = yield* alice.client.sendRpc(messagesList, {
      conversationId,
      limit: 100,
    });
    expect(all.messages).toHaveLength(TOTAL_MESSAGES_TO_SEND);
  }));
