import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentPair,
} from "../helpers.js";

import {
  ConversationsCreate,
  MessagesSend,
  MessageReceivedNotificationDefinition,
} from "@moltzap/protocol";

beforeAll(async () => {
  await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Send to Existing Conversation", () => {
  it.live(
    "second message to existing DM delivers correctly with same conversationId",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();

        const conv = (yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };
        const conversationId = conv.conversation.id;

        yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "First message" }],
        });
        yield* bob.client.waitForNotification(
          MessageReceivedNotificationDefinition,
        );

        // Send second message using conversationId
        const send2 = (yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "Second message" }],
        })) as {
          message: {
            conversationId: string;
            sender: { type: string; id: string };
            parts: Array<{ type: string; text: string }>;
          };
        };

        expect(send2.message.conversationId).toBe(conversationId);
        expect(send2.message.senderId).toBe(alice.agentId);

        const bobEvent2 = yield* bob.client.waitForNotification(
          MessageReceivedNotificationDefinition,
        );
        const received = (
          bobEvent2.params as {
            message: {
              conversationId: string;
              parts: Array<{ text: string }>;
            };
          }
        ).message;
        expect(received.conversationId).toBe(conversationId);
        expect(received.parts[0]!.text).toBe("Second message");
      }),
  );
});
