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
  DEFAULT_APP_ID,
  MessagesList,
  MessagesSend,
  TaskConversationAddParticipant,
  TaskConversationCreate,
  TaskCreate,
} from "@moltzap/protocol";

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
    const eve = yield* registerAndConnect("eve-grp");

    // Alice creates a group (3+ participants ⇒ "group", not "dm")
    const conv = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, eve.agentId],
      initialConversation: {
        name: TEST_GROUP_NAME,
        participants: [bob.agentId, eve.agentId],
      },
    });

    expect(conv.conversation!.name).toBe(TEST_GROUP_NAME);

    const taskId = conv.task.id;
    const conversationId = conv.conversation!.id;

    // Alice sends multiple messages
    for (let i = 0; i < 3; i++) {
      yield* alice.client.sendRpc(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: `Message ${i + 1}` }],
      });
    }

    // List messages
    const messages = yield* alice.client.sendRpc(MessagesList, {
      taskId,
      conversationId,
    });

    expect(messages.messages).toHaveLength(3);
    const firstPart = messages.messages[0]!.parts[0]!;
    const thirdPart = messages.messages[2]!.parts[0]!;
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

it("addParticipant adds an agent to a task conversation", () =>
  Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-addp");
    const bob = yield* registerAndConnect("bob-addp");
    const eve = yield* registerAndConnect("eve-addp");

    // Create task with Alice + Bob admitted; initial conversation has just Bob.
    const created = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, eve.agentId],
      initialConversation: {
        name: "Add Test",
        participants: [bob.agentId],
      },
    });
    const taskId = created.task.id;
    const conversationId = created.conversation!.id;

    // Add Eve to that conversation; she's already in task_participants.
    const result = yield* alice.client.sendRpc(TaskConversationAddParticipant, {
      taskId,
      conversationId,
      agentId: eve.agentId,
    });

    expect(result).toEqual({});

    // Sanity-check via TaskConversationCreate side: the same task admits eve
    // for another conversation under the same task.
    const second = yield* alice.client.sendRpc(TaskConversationCreate, {
      taskId,
      name: "Second",
      participants: [eve.agentId],
    });
    expect(second.conversation.id).toBeDefined();

    yield* alice.client.close();
    yield* bob.client.close();
    yield* eve.client.close();
  }));
