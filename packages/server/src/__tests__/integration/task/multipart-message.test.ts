import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Fiber } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
  textOfPart,
} from "../helpers.js";

import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import {
  messageReceivedNotificationDefinition,
  messagesList,
  messagesSend,
} from "@moltzap/protocol/message";

const PART_ONE_TEXT = "Part 1: Introduction";
const PART_TWO_TEXT = "Part 2: Main content";
const PART_THREE_TEXT = "Part 3: Conclusion";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("message with multiple text parts preserves all parts in order", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId =
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.id;

    const parts = [
      { type: "text" as const, text: PART_ONE_TEXT },
      { type: "text" as const, text: PART_TWO_TEXT },
      { type: "text" as const, text: PART_THREE_TEXT },
    ] as const;

    const bobEventFiber = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );

    const sendResult = yield* alice.client.sendRpc(messagesSend, {
      taskId,
      conversationId,
      parts,
    });

    expect(sendResult.message.parts).toHaveLength(3);
    expect(sendResult.message.parts).toEqual(parts);

    const bobEvent = yield* Fiber.join(bobEventFiber);
    const received = bobEvent.params.message;

    expect(received.parts).toHaveLength(3);
    expect(textOfPart(received.parts[0])).toBe(PART_ONE_TEXT);
    expect(textOfPart(received.parts[1])).toBe(PART_TWO_TEXT);
    expect(textOfPart(received.parts[2])).toBe(PART_THREE_TEXT);

    // Verify via message listing
    const history = yield* bob.client.sendRpc(messagesList, {
      taskId,
      conversationId,
    });
    expect(history.messages).toHaveLength(1);
    expect(
      /* Safe because the test fixture establishes this asserted shape. */ history
        .messages[0]!.parts,
    ).toEqual(parts);
  }));
