import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentPair,
  connectTestClient,
  type ServerTestClient,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
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

it("agent reconnects and retrieves messages sent while disconnected", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();
    let bobClient2: ServerTestClient | null = null;

    try {
      const conversationId = yield* createDm(alice.client, bob.agentId);
      yield* sendText(alice.client, conversationId, PRE_DISCONNECT_TEXT);
      yield* bob.client.waitForNotification(
        MessageReceivedNotificationDefinition,
      );

      yield* bob.client.close();
      yield* sendText(alice.client, conversationId, OFFLINE_TEXT);

      // Bob reconnects with the same API key
      bobClient2 = yield* connectTestClient({
        wsUrl,
        agentId: bob.agentId,
        apiKey: bob.apiKey,
      });

      yield* expectReconnectedHistory(bobClient2, conversationId);
      yield* sendText(bobClient2, conversationId, BACK_ONLINE_TEXT);

      const aliceEvent = yield* alice.client.waitForNotification(
        MessageReceivedNotificationDefinition,
      );
      expect(messageText(aliceEvent.params)).toBe(BACK_ONLINE_TEXT);
    } finally {
      if (bobClient2) yield* bobClient2.close();
    }
  }));

function createDm(client: ServerTestClient, participantAgentId: string) {
  return Effect.gen(function* () {
    const conv = (yield* client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: participantAgentId }],
    })) as { conversation: { id: string } };
    return conv.conversation.id;
  });
}

function sendText(
  client: ServerTestClient,
  conversationId: string,
  text: string,
) {
  return client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: "text", text }],
  });
}

function expectReconnectedHistory(
  client: ServerTestClient,
  conversationId: string,
) {
  return Effect.gen(function* () {
    const msgs = (yield* client.sendRpc(MessagesList, {
      conversationId,
    })) as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };

    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0]!.parts[0]!.text).toBe(PRE_DISCONNECT_TEXT);
    expect(msgs.messages[1]!.parts[0]!.text).toBe(OFFLINE_TEXT);
  });
}

function messageText(params: unknown): string {
  return (params as { message: { parts: Array<{ text: string }> } }).message
    .parts[0]!.text;
}
