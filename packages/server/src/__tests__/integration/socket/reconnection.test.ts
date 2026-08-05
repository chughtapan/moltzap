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
  connectTestClient,
  trackClient,
  type TestAgentClient,
} from "../helpers.js";

import {
  messageReceivedNotificationDefinition,
  messagesList,
  messagesSend,
} from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  agentConversationCreate,
  type ConversationId,
} from "@moltzap/protocol/conversation";

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
  readonly conversationId: ConversationId;
}

it("agent reconnects and retrieves messages sent while disconnected", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupAgentPair();

    const binding = yield* createDm(alice.client, bob.agentId);
    const preDisconnectFiber = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );
    yield* sendText(alice.client, binding, PRE_DISCONNECT_TEXT);
    yield* Fiber.join(preDisconnectFiber);

    yield* bob.client.close();
    yield* sendText(alice.client, binding, OFFLINE_TEXT);

    const bobClient2 = yield* connectTestClient({
      wsUrl,
      agentId: bob.agentId,
      apiKey: bob.apiKey,
    });
    trackClient(bobClient2);

    yield* expectReconnectedHistory(bobClient2, binding);
    const aliceEventFiber = yield* Effect.fork(
      awaitOneNotification(alice.client, messageReceivedNotificationDefinition),
    );
    yield* sendText(bobClient2, binding, BACK_ONLINE_TEXT);

    const aliceEvent = yield* Fiber.join(aliceEventFiber);
    expect(messageText(aliceEvent.params)).toBe(BACK_ONLINE_TEXT);
  }));

function createDm(
  client: TestAgentClient,
  participantAgentId: AgentId,
): Effect.Effect<DmBinding, unknown> {
  return Effect.gen(function* () {
    const conv = yield* client.sendRpc(agentConversationCreate, {
      participants: [participantAgentId],
    });
    return { conversationId: conv.conversation.id };
  });
}

function sendText(client: TestAgentClient, binding: DmBinding, text: string) {
  return client.sendRpc(messagesSend, {
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
  });
}

function expectReconnectedHistory(client: TestAgentClient, binding: DmBinding) {
  return Effect.gen(function* () {
    const msgs = yield* client.sendRpc(messagesList, {
      conversationId: binding.conversationId,
    });

    expect(msgs.messages).toHaveLength(2);
    expect(
      firstTextPart(
        /* Safe because the test fixture establishes this asserted shape. */ msgs
          .messages[0]!.parts,
      ),
    ).toBe(PRE_DISCONNECT_TEXT);
    expect(
      firstTextPart(
        /* Safe because the test fixture establishes this asserted shape. */ msgs
          .messages[1]!.parts,
      ),
    ).toBe(OFFLINE_TEXT);
  });
}

function messageText(params: unknown): string {
  const parts =
    /* Safe because the test fixture establishes this asserted shape. */
    (params as { message: { parts: Array<{ text: string }> } }).message.parts;
  const firstPart = parts[0];
  if (firstPart === undefined) {
    throw new Error("Expected a message text part.");
  }
  return firstPart.text;
}
