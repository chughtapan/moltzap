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
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
} from "../helpers.js";

import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "@moltzap/protocol/message";

const ALIVE_AFTER_IDLE_TEXT = "Still alive after idle";
const REPLY_AFTER_IDLE_TEXT = "Reply after idle";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("connection survives idle period and still delivers messages", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    // Wait 5 seconds of idle time
    yield* Effect.sleep(DEFAULT_NOTIFICATION_TIMEOUT_MS);

    const bobEventFiber = yield* Effect.fork(
      awaitOneNotification(bob.client, MessageReceivedNotificationDefinition),
    );

    // After idle period, Alice sends a message
    yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: ALIVE_AFTER_IDLE_TEXT }],
    });

    const bobEvent = yield* Fiber.join(bobEventFiber);
    const received = bobEvent.params.message;
    expect(firstTextPart(received.parts)).toBe(ALIVE_AFTER_IDLE_TEXT);

    const aliceEventFiber = yield* Effect.fork(
      awaitOneNotification(alice.client, MessageReceivedNotificationDefinition),
    );

    // Verify bidirectional: Bob replies after idle
    yield* bob.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts: [{ type: "text", text: REPLY_AFTER_IDLE_TEXT }],
    });

    const aliceEvent = yield* Fiber.join(aliceEventFiber);
    const aliceReceived = aliceEvent.params.message;
    expect(firstTextPart(aliceReceived.parts)).toBe(REPLY_AFTER_IDLE_TEXT);
  }));
