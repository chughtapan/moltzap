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
  connectTestClient,
  type ServerTestClient,
} from "../helpers.js";

import {
  DEFAULT_APP_ID,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TaskRequest,
  type AgentId,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol";

const PRE_DISCONNECT_TEXT = "Pre-disconnect";
const OFFLINE_TEXT = "Sent while you were away";
const BACK_ONLINE_TEXT = "I am back online";

let wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const urls = yield* startTestServerEffect();
      wsUrl = urls.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

interface DmBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

it("agent reconnects and retrieves messages sent while disconnected", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    let bobClient2: ServerTestClient | null = null;

    try {
      const binding = yield* createDm(alice.client, bob.agentId);
      yield* sendText(alice.client, binding, PRE_DISCONNECT_TEXT);
      yield* awaitOneNotification(
        bob.client,
        MessageReceivedNotificationDefinition,
      );

      yield* bob.client.close();
      yield* sendText(alice.client, binding, OFFLINE_TEXT);

      // Bob reconnects with the same API key
      bobClient2 = yield* connectTestClient({
        wsUrl,
        agentId: bob.agentId,
        apiKey: bob.apiKey,
      });

      yield* expectReconnectedHistory(bobClient2, binding);
      yield* sendText(bobClient2, binding, BACK_ONLINE_TEXT);

      const aliceEvent = yield* awaitOneNotification(
        alice.client,
        MessageReceivedNotificationDefinition,
      );
      expect(messageText(aliceEvent.params)).toBe(BACK_ONLINE_TEXT);
    } finally {
      if (bobClient2) yield* bobClient2.close();
    }
  }));

function createDm(
  client: ServerTestClient,
  participantAgentId: AgentId,
): Effect.Effect<DmBinding, unknown> {
  return Effect.gen(function* () {
    const conv = yield* client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [participantAgentId],
      initialConversation: { participants: [participantAgentId] },
    });
    return { taskId: conv.task.id, conversationId: conv.conversation!.id };
  });
}

function sendText(client: ServerTestClient, binding: DmBinding, text: string) {
  return client.sendRpc(MessagesSend, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
  });
}

function expectReconnectedHistory(
  client: ServerTestClient,
  binding: DmBinding,
) {
  return Effect.gen(function* () {
    const msgs = yield* client.sendRpc(MessagesList, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });

    expect(msgs.messages).toHaveLength(2);
    expect(firstTextPart(msgs.messages[0]!.parts)).toBe(PRE_DISCONNECT_TEXT);
    expect(firstTextPart(msgs.messages[1]!.parts)).toBe(OFFLINE_TEXT);
  });
}

function messageText(params: unknown): string {
  return (params as { message: { parts: Array<{ text: string }> } }).message
    .parts[0]!.text;
}
