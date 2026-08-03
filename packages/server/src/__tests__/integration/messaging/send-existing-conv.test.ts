import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Fiber } from "effect";
import {
  awaitOneNotification,
  firstTextPart,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import { agentConversationCreate } from "@moltzap/protocol/conversation";
import {
  messageReceivedNotificationDefinition,
  messagesSend,
} from "@moltzap/protocol/message";

const FIRST_MESSAGE_TEXT = "First message";
const SECOND_MESSAGE_TEXT = "Second message";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("second message to existing DM delivers correctly with same conversationId", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(agentConversationCreate, {
      participants: [bob.agentId],
    });
    const conversationId = conv.conversation.id;

    const firstBobEvent = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );
    yield* alice.client.sendRpc(messagesSend, {
      conversationId,
      parts: [{ type: "text", text: FIRST_MESSAGE_TEXT }],
    });
    yield* Fiber.join(firstBobEvent);

    // Send second message using conversationId
    const secondBobEvent = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );
    const send2 = yield* alice.client.sendRpc(messagesSend, {
      conversationId,
      parts: [{ type: "text", text: SECOND_MESSAGE_TEXT }],
    });

    expect(send2.message.conversationId).toBe(conversationId);
    expect(send2.message.senderId).toBe(alice.agentId);

    const bobEvent2 = yield* Fiber.join(secondBobEvent);
    const received = bobEvent2.params.message;
    expect(received.conversationId).toBe(conversationId);
    expect(firstTextPart(received.parts)).toBe(SECOND_MESSAGE_TEXT);
  }));
