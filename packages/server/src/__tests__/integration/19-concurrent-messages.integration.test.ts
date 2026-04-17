import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentGroup,
} from "./helpers.js";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  _baseUrl = server.baseUrl;
  _wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Concurrent Messages", () => {
  it.live(
    "multiple DMs receive messages simultaneously without cross-talk",
    () =>
      Effect.gen(function* () {
        const { agents } = yield* setupAgentGroup(5);

        const sender = agents[0]!;
        const receivers = agents.slice(1);

        // Create 4 separate DM conversations between agent-0 and each of agents 1-4
        const conversations: Array<{ id: string; receiverIdx: number }> = [];
        for (let i = 0; i < receivers.length; i++) {
          const conv = (yield* sender.client.sendRpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: receivers[i]!.agentId }],
          })) as { conversation: { id: string } };
          conversations.push({ id: conv.conversation.id, receiverIdx: i });
        }

        // Set up event waiters on all receivers BEFORE sending

        // Send messages to all 4 conversations simultaneously
        yield* Effect.all(
          conversations.map((conv, i) =>
            sender.client.sendRpc("messages/send", {
              conversationId: conv.id,
              parts: [{ type: "text", text: `Hello receiver-${i + 1}` }],
            }),
          ),
          { concurrency: "unbounded" },
        );

        const events = yield* Effect.all(
          receivers.map((r) => r.client.waitForEvent("messages/received")),
          { concurrency: "unbounded" },
        );

        for (let i = 0; i < events.length; i++) {
          const event = events[i]!;
          const data = event.data as {
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
          const extra = receiver.client
            .drainEvents()
            .filter((e) => e.event === "messages/received");
          expect(extra).toHaveLength(0);
        }
      }),
  );
});
