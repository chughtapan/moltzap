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

describe("Message History Pagination", () => {
  it("paginated message listing returns correct pages with no gaps or duplicates", async () => {
    const { alice, bob } = await setupAgentPair();

    const conv = (await alice.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      // Send 25 messages
      const sentSeqs: number[] = [];
      for (let i = 1; i <= 25; i++) {
        const result = (await alice.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: `Message ${i}` }],
        })) as { message: { seq: number } };
        sentSeqs.push(result.message.seq);
      }

      // First page: most recent 10
      const page1 = (await alice.client.rpc("messages/list", {
        conversationId,
        limit: 10,
      })) as {
        messages: Array<{ seq: number; parts: Array<{ text: string }> }>;
        hasMore: boolean;
      };
      expect(page1.messages).toHaveLength(10);
      expect(page1.hasMore).toBe(true);

      const page1Seqs = page1.messages.map((m) => m.seq);

      // Verify ascending order within page
      for (let i = 1; i < page1Seqs.length; i++) {
        expect(page1Seqs[i]!).toBeGreaterThan(page1Seqs[i - 1]!);
      }

      // Second page using beforeSeq of the first message in page1
      const page2 = (await alice.client.rpc("messages/list", {
        conversationId,
        limit: 10,
        beforeSeq: page1Seqs[0],
      })) as {
        messages: Array<{ seq: number; parts: Array<{ text: string }> }>;
        hasMore: boolean;
      };
      expect(page2.messages).toHaveLength(10);
      expect(page2.hasMore).toBe(true);

      const page2Seqs = page2.messages.map((m) => m.seq);

      for (let i = 1; i < page2Seqs.length; i++) {
        expect(page2Seqs[i]!).toBeGreaterThan(page2Seqs[i - 1]!);
      }

      // Third page: remaining 5
      const page3 = (await alice.client.rpc("messages/list", {
        conversationId,
        limit: 10,
        beforeSeq: page2Seqs[0],
      })) as {
        messages: Array<{ seq: number; parts: Array<{ text: string }> }>;
        hasMore: boolean;
      };
      expect(page3.messages).toHaveLength(5);
      expect(page3.hasMore).toBe(false);

      // Verify no duplicates across all pages
      const allSeqs = [
        ...page3.messages.map((m) => m.seq),
        ...page2Seqs,
        ...page1Seqs,
      ];
      const uniqueSeqs = new Set(allSeqs);
      expect(uniqueSeqs.size).toBe(25);

      // Verify overall ascending seq order (page3 oldest, page1 newest)
      for (let i = 1; i < allSeqs.length; i++) {
        expect(allSeqs[i]!).toBeGreaterThan(allSeqs[i - 1]!);
      }
  });
});
