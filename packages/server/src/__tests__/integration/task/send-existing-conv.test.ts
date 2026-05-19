import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

const FIRST_MESSAGE_TEXT = "First message";
const SECOND_MESSAGE_TEXT = "Second message";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("second message to existing DM delivers correctly with same conversationId", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    yield* alice.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: FIRST_MESSAGE_TEXT }],
    });
    yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );

    // Send second message using conversationId
    const send2 = (yield* alice.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: SECOND_MESSAGE_TEXT }],
    })) as {
      message: {
        conversationId: string;
        sender: { type: string; id: string };
        parts: Array<{ type: string; text: string }>;
      };
    };

    expect(send2.message.conversationId).toBe(conversationId);
    expect(send2.message.senderId).toBe(alice.agentId);

    const bobEvent2 = yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );
    const received = (
      bobEvent2.params as {
        message: {
          conversationId: string;
          parts: Array<{ text: string }>;
        };
      }
    ).message;
    expect(received.conversationId).toBe(conversationId);
    expect(received.parts[0]!.text).toBe(SECOND_MESSAGE_TEXT);
  }));
