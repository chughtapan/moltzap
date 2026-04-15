import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentPair,
} from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Message History", () => {
  it("message listing returns messages in ascending order with hasMore", async () => {
    const { alice, bob } = await setupAgentPair();

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    // Send 15 messages
    for (let i = 1; i <= 15; i++) {
      await alice.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: `Message ${i}` }],
      });
    }

    // List with limit=10 — should get newest 10 and hasMore=true
    const page1 = (await alice.client.rpc("messages/list", {
      conversationId,
      limit: 10,
    })) as {
      messages: Array<{
        id: string;
        senderId: string;
        parts: Array<{ text: string }>;
      }>;
      hasMore: boolean;
    };
    expect(page1.messages).toHaveLength(10);
    expect(page1.hasMore).toBe(true);

    // Messages are returned in ascending order (oldest first in page)
    const texts = page1.messages.map((m) => m.parts[0]!.text);
    // Newest 10 = Message 6 through Message 15
    expect(texts[0]).toBe("Message 6");
    expect(texts[9]).toBe("Message 15");

    // All messages have createdBy set to alice's agent ID
    for (const m of page1.messages) {
      expect(m.senderId).toBe(alice.agentId);
    }

    // No duplicate IDs
    const ids = page1.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(10);

    // List all — should get all 15
    const all = (await alice.client.rpc("messages/list", {
      conversationId,
      limit: 100,
    })) as {
      messages: Array<{ id: string; parts: Array<{ text: string }> }>;
      hasMore: boolean;
    };
    expect(all.messages).toHaveLength(15);
    expect(all.hasMore).toBe(false);
  });
});
