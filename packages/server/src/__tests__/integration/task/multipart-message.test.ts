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
  DEFAULT_APP_ID,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskRequest,
} from "@moltzap/protocol";

const PART_ONE_TEXT = "Part 1: Introduction";
const PART_TWO_TEXT = "Part 2: Main content";
const PART_THREE_TEXT = "Part 3: Conclusion";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("message with multiple text parts preserves all parts in order", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const conv = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    const parts = [
      { type: "text" as const, text: PART_ONE_TEXT },
      { type: "text" as const, text: PART_TWO_TEXT },
      { type: "text" as const, text: PART_THREE_TEXT },
    ];

    // Set up Bob's event waiter BEFORE send

    const sendResult = yield* alice.client.sendRpc(MessagesSend, {
      taskId,
      conversationId,
      parts,
    });

    expect(sendResult.message.parts).toHaveLength(3);
    expect(sendResult.message.parts).toEqual(parts);

    const bobEvent = yield* awaitOneNotification(
      bob.client,
      MessageReceivedNotificationDefinition,
    );
    const received = (
      bobEvent.params as {
        message: { parts: Array<{ type: string; text: string }> };
      }
    ).message;

    expect(received.parts).toHaveLength(3);
    expect(received.parts[0]!.text).toBe(PART_ONE_TEXT);
    expect(received.parts[1]!.text).toBe(PART_TWO_TEXT);
    expect(received.parts[2]!.text).toBe(PART_THREE_TEXT);

    // Verify via message listing
    const history = yield* bob.client.sendRpc(MessagesList, {
      taskId,
      conversationId,
    });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.parts).toEqual(parts);
  }));
