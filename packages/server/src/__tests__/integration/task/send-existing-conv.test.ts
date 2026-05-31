import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  awaitOneNotification,
  firstTextPart,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
} from "../helpers.js";

import {
  DEFAULT_APP_ID,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskRequest,
} from "@moltzap/protocol";

const FIRST_MESSAGE_TEXT = "First message";
const SECOND_MESSAGE_TEXT = "Second message";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("second message to existing DM delivers correctly with same conversationId", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: FIRST_MESSAGE_TEXT }],
    });
    yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );

    // Send second message using conversationId
    const send2 = yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: SECOND_MESSAGE_TEXT }],
    });

    expect(send2.message.conversationId).toBe(conversationId);
    expect(send2.message.senderId).toBe(alice.agentId);

    const bobEvent2 = yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );
    const received = bobEvent2.params.message;
    expect(received.conversationId).toBe(conversationId);
    expect(firstTextPart(received.parts)).toBe(SECOND_MESSAGE_TEXT);
  }));
