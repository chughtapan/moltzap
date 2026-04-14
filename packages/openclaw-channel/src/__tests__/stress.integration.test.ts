/**
 * Stress integration tests: concurrent multi-agent messaging.
 * Uses shared container from globalSetup — no per-test container startup.
 */

import { describe, it, expect, inject, beforeAll, afterAll } from "vitest";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { getLogs } from "../test-utils/container-core.js";
import {
  initWorker,
  cleanupWorker,
  registerAndClaim,
  makeContact,
  extractConvId,
  extractText,
} from "./test-helpers.js";
import type { Message } from "@moltzap/protocol";

let baseUrl: string;
let wsUrl: string;

async function waitForRepliesByList(params: {
  client: MoltZapTestClient;
  conversationId: string;
  receiverAgentId: string;
  expectedCount: number;
  timeoutMs: number;
}): Promise<Message[]> {
  const deadline = Date.now() + params.timeoutMs;

  while (Date.now() < deadline) {
    const result = (await params.client.rpc("messages/list", {
      conversationId: params.conversationId,
      limit: 50,
    })) as { messages: Message[] };

    const replies = result.messages.filter(
      (m) =>
        m.sender.type === "agent" &&
        m.senderId === params.receiverAgentId &&
        extractText(m).includes("ECHO:"),
    );

    if (replies.length >= params.expectedCount) {
      return replies.slice(0, params.expectedCount);
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(
    `Timed out waiting for ${params.expectedCount} replies in ${params.conversationId}`,
  );
}

describe("Stress: concurrent multi-agent messaging", () => {
  const receiverAgentId = inject("containerAAgentId");
  const receiverUserId = inject("containerAUserId");
  const containerAId = inject("containerAId");

  beforeAll(() => {
    initWorker();
    baseUrl = inject("baseUrl");
    wsUrl = inject("wsUrl");
  });

  afterAll(async () => {
    await cleanupWorker();
  });

  it("10 concurrent messages from 3 agents all get echo replies", async () => {
    const agentA = await registerAndClaim("stress-a");
    const agentB = await registerAndClaim("stress-b");
    const agentC = await registerAndClaim("stress-c");

    await makeContact(agentA.userId, receiverUserId);
    await makeContact(agentB.userId, receiverUserId);
    await makeContact(agentC.userId, receiverUserId);

    try {
      const clientA = new MoltZapTestClient(baseUrl, wsUrl);
      const clientB = new MoltZapTestClient(baseUrl, wsUrl);
      const clientC = new MoltZapTestClient(baseUrl, wsUrl);
      await Promise.all([
        clientA.connect(agentA.apiKey),
        clientB.connect(agentB.apiKey),
        clientC.connect(agentC.apiKey),
      ]);

      const [convA, convB, convC] = await Promise.all([
        clientA
          .rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: receiverAgentId }],
          })
          .then(extractConvId),
        clientB
          .rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: receiverAgentId }],
          })
          .then(extractConvId),
        clientC
          .rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: receiverAgentId }],
          })
          .then(extractConvId),
      ]);

      const sendPromises = [
        ...Array.from({ length: 4 }, (_, i) =>
          clientA.rpc("messages/send", {
            conversationId: convA,
            parts: [{ type: "text", text: `A-msg-${i}` }],
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          clientB.rpc("messages/send", {
            conversationId: convB,
            parts: [{ type: "text", text: `B-msg-${i}` }],
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          clientC.rpc("messages/send", {
            conversationId: convC,
            parts: [{ type: "text", text: `C-msg-${i}` }],
          }),
        ),
      ];

      await Promise.all(sendPromises);

      const [repliesA, repliesB, repliesC] = await Promise.all([
        waitForRepliesByList({
          client: clientA,
          conversationId: convA,
          receiverAgentId,
          expectedCount: 4,
          timeoutMs: 90_000,
        }),
        waitForRepliesByList({
          client: clientB,
          conversationId: convB,
          receiverAgentId,
          expectedCount: 3,
          timeoutMs: 90_000,
        }),
        waitForRepliesByList({
          client: clientC,
          conversationId: convC,
          receiverAgentId,
          expectedCount: 3,
          timeoutMs: 90_000,
        }),
      ]);

      expect(repliesA).toHaveLength(4);
      expect(repliesB).toHaveLength(3);
      expect(repliesC).toHaveLength(3);

      for (const reply of repliesA) {
        expect(reply.senderId).toBe(receiverAgentId);
        expect(reply.conversationId).toBe(convA);
        expect(extractText(reply)).toContain("ECHO:");
      }
      for (const reply of repliesB) {
        expect(reply.senderId).toBe(receiverAgentId);
        expect(reply.conversationId).toBe(convB);
        expect(extractText(reply)).toContain("ECHO:");
      }
      for (const reply of repliesC) {
        expect(reply.senderId).toBe(receiverAgentId);
        expect(reply.conversationId).toBe(convC);
        expect(extractText(reply)).toContain("ECHO:");
      }

      const allReplyIds = [
        ...repliesA.map((r) => r.id),
        ...repliesB.map((r) => r.id),
        ...repliesC.map((r) => r.id),
      ];
      const uniqueIds = new Set(allReplyIds);
      expect(uniqueIds.size).toBe(10);

      clientA.close();
      clientB.close();
      clientC.close();
    } catch (err) {
      console.error("=== STRESS CONTAINER LOGS ===");
      console.error(getLogs(containerAId));
      console.error("=== END CONTAINER LOGS ===");
      throw err;
    }
  }, 180_000);
});
