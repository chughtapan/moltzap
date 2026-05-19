import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

const ALIVE_AFTER_IDLE_TEXT = "Still alive after idle";
const REPLY_AFTER_IDLE_TEXT = "Reply after idle";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("connection survives idle period and still delivers messages", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    // Wait 5 seconds of idle time
    yield* Effect.sleep(DEFAULT_NOTIFICATION_TIMEOUT_MS);

    // After idle period, Alice sends a message
    yield* alice.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: ALIVE_AFTER_IDLE_TEXT }],
    });

    const bobEvent = yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );
    const received = (
      bobEvent.params as { message: { parts: Array<{ text: string }> } }
    ).message;
    expect(received.parts[0]!.text).toBe(ALIVE_AFTER_IDLE_TEXT);

    // Verify bidirectional: Bob replies after idle
    yield* bob.client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: REPLY_AFTER_IDLE_TEXT }],
    });

    const aliceEvent = yield* awaitOneNotification(
      alice.client,
      MessageReceivedNotificationDefinition,
    );
    const aliceReceived = (
      aliceEvent.params as { message: { parts: Array<{ text: string }> } }
    ).message;
    expect(aliceReceived.parts[0]!.text).toBe(REPLY_AFTER_IDLE_TEXT);
  }));
