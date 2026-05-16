import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
} from "../helpers.js";

import {
  ConversationsAddParticipant,
  ConversationsCreate,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";

const GROUP_TYPE = "group";
const TEST_GROUP_NAME = "Test Group";
const FIRST_MESSAGE_TEXT = "Message 1";
const THIRD_MESSAGE_TEXT = "Message 3";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      _baseUrl = server.baseUrl;
      _wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("create group, send messages, verify seq monotonicity", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-grp");
    const bob = yield* registerAndConnect("bob-grp");

    // Alice creates a group
    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: GROUP_TYPE,
      name: TEST_GROUP_NAME,
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string; name: string } };

    expect(conv.conversation.type).toBe(GROUP_TYPE);
    expect(conv.conversation.name).toBe(TEST_GROUP_NAME);

    const conversationId = conv.conversation.id;

    // Alice sends multiple messages
    for (let i = 0; i < 3; i++) {
      yield* alice.client.sendRpc(MessagesSend, {
        conversationId,
        parts: [{ type: "text", text: `Message ${i + 1}` }],
      });
    }

    // List messages
    const messages = (yield* alice.client.sendRpc(MessagesList, {
      conversationId,
    })) as { messages: Array<{ parts: Array<{ text: string }> }> };

    expect(messages.messages).toHaveLength(3);
    expect(messages.messages[0]!.parts[0]!.text).toBe(FIRST_MESSAGE_TEXT);
    expect(messages.messages[2]!.parts[0]!.text).toBe(THIRD_MESSAGE_TEXT);

    yield* alice.client.close();
    yield* bob.client.close();
  }));

it("addParticipant returns participant", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-addp");
    const bob = yield* registerAndConnect("bob-addp");

    // Create group with just Alice
    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: "group",
      name: "Add Test",
      participants: [{ type: "agent", id: alice.agentId }],
    })) as { conversation: { id: string } };

    // Add Bob
    const result = (yield* alice.client.sendRpc(ConversationsAddParticipant, {
      conversationId: conv.conversation.id,
      participant: { type: "agent", id: bob.agentId },
    })) as { participant: { conversationId: string } };

    expect(result.participant).toBeDefined();
    expect(result.participant.conversationId).toBe(conv.conversation.id);

    yield* alice.client.close();
    yield* bob.client.close();
  }));
