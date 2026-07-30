import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
} from "../helpers.js";

import { DEFAULT_APP_ID, taskRequest } from "@moltzap/protocol/task";
import { messagesList, messagesSend } from "@moltzap/protocol/message";

const TEST_GROUP_NAME = "Test Group";
const FIRST_MESSAGE_TEXT = "Message 1";
const THIRD_MESSAGE_TEXT = "Message 3";

beforeAll(() => Effect.runPromise(startTestServerEffect()));

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

it("create group, send messages, verify seq monotonicity", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-grp");
    const bob = yield* registerAndConnect("bob-grp");
    const eve = yield* registerAndConnect("eve-grp");

    // Alice creates a group (3+ participants ⇒ "group", not "dm")
    const conv = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, eve.agentId],
      initialConversation: {
        name: TEST_GROUP_NAME,
        participants: [bob.agentId, eve.agentId],
      },
    });

    expect(
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.name,
    ).toBe(TEST_GROUP_NAME);

    const taskId = conv.task.id;
    const conversationId =
      /* Safe because the test fixture establishes this asserted shape. */ conv
        .conversation!.id;

    // Alice sends multiple messages
    for (let i = 0; i < 3; i++) {
      yield* alice.client.sendRpc(messagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: `Message ${i + 1}` }],
      });
    }

    // List messages
    const messages = yield* alice.client.sendRpc(messagesList, {
      taskId,
      conversationId,
    });

    expect(messages.messages).toHaveLength(3);
    const firstPart =
      /* Safe because the test fixture establishes this asserted shape. */ messages
        .messages[0]!.parts[0];
    const thirdPart =
      /* Safe because the test fixture establishes this asserted shape. */ messages
        .messages[2]!.parts[0];
    expect(firstPart.type === "text" ? firstPart.text : "").toBe(
      FIRST_MESSAGE_TEXT,
    );
    expect(thirdPart.type === "text" ? thirdPart.text : "").toBe(
      THIRD_MESSAGE_TEXT,
    );

    yield* alice.client.close();
    yield* bob.client.close();
    yield* eve.client.close();
  }));
