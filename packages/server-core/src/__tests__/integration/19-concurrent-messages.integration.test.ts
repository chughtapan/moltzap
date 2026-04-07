import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  it("multiple DMs receive messages simultaneously without cross-talk", async () => {
    const { agents } = await setupAgentGroup(5);

    const sender = agents[0]!;
    const receivers = agents.slice(1);

    // Create 4 separate DM conversations between agent-0 and each of agents 1-4
    const conversations: Array<{ id: string; receiverIdx: number }> = [];
    for (let i = 0; i < receivers.length; i++) {
      const conv = (await sender.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: receivers[i]!.agentId }],
      })) as { conversation: { id: string } };
      conversations.push({ id: conv.conversation.id, receiverIdx: i });
    }

    // Set up event waiters on all receivers BEFORE sending
    const eventPromises = receivers.map((r) =>
      r.client.waitForEvent("messages/received"),
    );

    // Send messages to all 4 conversations simultaneously
    await Promise.all(
      conversations.map((conv, i) =>
        sender.client.rpc("messages/send", {
          conversationId: conv.id,
          parts: [{ type: "text", text: `Hello receiver-${i + 1}` }],
        }),
      ),
    );

    const events = await Promise.all(eventPromises);

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
  });
});
