import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  setupAgentGroup,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

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

it("multiple DMs receive messages simultaneously without cross-talk", () =>
  Effect.gen(function* () {
    const { agents } = yield* setupAgentGroup(5);

    const sender = agents[0]!;
    const receivers = agents.slice(1);

    // Create 4 separate DM conversations between agent-0 and each of agents 1-4
    const conversations: Array<{ id: string; receiverIdx: number }> = [];
    for (let i = 0; i < receivers.length; i++) {
      const conv = (yield* sender.client.sendRpc(ConversationsCreate, {
        type: "dm",
        participants: [{ type: "agent", id: receivers[i]!.agentId }],
      })) as { conversation: { id: string } };
      conversations.push({ id: conv.conversation.id, receiverIdx: i });
    }

    // Set up event waiters on all receivers BEFORE sending

    // Send messages to all 4 conversations simultaneously
    yield* Effect.all(
      conversations.map((conv, i) =>
        sender.client.sendRpc(MessagesSend, {
          conversationId: conv.id,
          parts: [{ type: "text", text: `Hello receiver-${i + 1}` }],
        }),
      ),
      { concurrency: conversations.length },
    );

    const events = yield* Effect.all(
      receivers.map((r) =>
        awaitOneNotification(r.client, MessageReceivedNotificationDefinition),
      ),
      { concurrency: receivers.length },
    );

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      const data = event.params as {
        message: {
          conversationId: string;
          parts: Array<{ text: string }>;
        };
      };

      expect(data.message.conversationId).toBe(conversations[i]!.id);
      expect(data.message.parts[0]!.text).toBe(`Hello receiver-${i + 1}`);
    }

    // Verify no extra events leaked to any receiver
    for (const receiver of receivers) {
      const drained = yield* receiver.client.drainNotifications;
      const extra = drained.filter(
        (e) => e.definition === MessageReceivedNotificationDefinition,
      );
      expect(extra).toHaveLength(0);
    }
  }));
