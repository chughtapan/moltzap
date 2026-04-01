/**
 * Tier 2: Real OpenClaw gateway + real MoltZap server integration tests.
 *
 * Every test uses shared OpenClaw containers (started in globalSetup) with an
 * echo model provider -- no LLM API keys required. Verifies message routing,
 * not LLM quality.
 */

import { describe, it, expect, inject, beforeAll, afterAll } from "vitest";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";
import { getLogs } from "../test-utils/container-core.js";
import {
  initWorker,
  cleanupWorker,
  registerAndClaim,
  makeContact,
  extractMessage,
  extractConvId,
  extractText,
} from "./test-helpers.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(() => {
  initWorker();
  baseUrl = inject("baseUrl");
  wsUrl = inject("wsUrl");
});

afterAll(async () => {
  await cleanupWorker();
});

describe.skipIf(inject("containerAId") === "")(
  "Real OpenClaw gateway integration",
  () => {
    const containerAId = inject("containerAId");
    const containerAAgentId = inject("containerAAgentId");
    const containerAUserId = inject("containerAUserId");
    const containerASupabaseUid = inject("containerASupabaseUid");
    const containerBAgentId = inject("containerBAgentId");
    const containerBUserId = inject("containerBUserId");

    // --- Gateway lifecycle ---

    it("gateway starts, loads MoltZap plugin, connects to server", () => {
      const logs = getLogs(containerAId);
      expect(logs).toContain("[gateway]");
      expect(logs).toContain("[moltzap]");
    }, 30_000);

    // --- Agent-to-agent tests (shared container A) ---

    describe("agent-to-agent messaging", () => {
      it("DM: alice sends -> OpenClaw dispatch -> echo reply arrives", async () => {
        const alice = await registerAndClaim("a2a-alice-dm");
        await makeContact(alice.userId, containerAUserId);

        const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient.connect(alice.apiKey);

        const convId = extractConvId(
          await aliceClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        const replyPromise = aliceClient.waitForEvent(
          "messages/received",
          60_000,
        );

        await aliceClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "hello from alice" }],
        });

        const reply = extractMessage(await replyPromise);
        expect(reply.parts.length).toBeGreaterThan(0);
        expect(reply.conversationId).toBe(convId);
        expect(reply.sender.id).toBe(containerAAgentId);
        expect(extractText(reply)).toContain("ECHO:");

        aliceClient.close();
      }, 90_000);

      it("group: message dispatched through real OpenClaw", async () => {
        const alice = await registerAndClaim("a2a-alice-grp");
        const eve = await registerAndClaim("a2a-eve-grp");
        await makeContact(alice.userId, containerAUserId);
        await makeContact(alice.userId, eve.userId);
        await makeContact(containerAUserId, eve.userId);

        const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient.connect(alice.apiKey);

        const convId = extractConvId(
          await aliceClient.rpc("conversations/create", {
            type: "group",
            name: "Integration Group",
            participants: [
              { type: "agent", id: containerAAgentId },
              { type: "agent", id: eve.agentId },
            ],
          }),
        );

        // Wait for conversation event to propagate to the gateway
        await new Promise((r) => setTimeout(r, 500));

        const replyPromise = aliceClient.waitForEvent(
          "messages/received",
          60_000,
        );

        await aliceClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "hello group" }],
        });

        const reply = extractMessage(await replyPromise);
        expect(reply.parts.length).toBeGreaterThan(0);
        expect(reply.conversationId).toBe(convId);
        expect(extractText(reply)).toContain("ECHO:");

        aliceClient.close();
      }, 90_000);

      it("rapid: multiple messages all get echo replies", async () => {
        const alice = await registerAndClaim("a2a-alice-rapid");
        await makeContact(alice.userId, containerAUserId);

        const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient.connect(alice.apiKey);

        const convId = extractConvId(
          await aliceClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        const replyPromises = [
          aliceClient.waitForEvent("messages/received", 60_000),
          aliceClient.waitForEvent("messages/received", 60_000),
          aliceClient.waitForEvent("messages/received", 60_000),
        ];

        for (let i = 0; i < 3; i++) {
          await aliceClient.rpc("messages/send", {
            conversationId: convId,
            parts: [{ type: "text", text: `Message ${i}` }],
          });
        }

        const replies = await Promise.all(replyPromises);
        expect(replies).toHaveLength(3);
        for (const r of replies) {
          const msg = extractMessage(r);
          expect(msg.parts.length).toBeGreaterThan(0);
          expect(msg.sender.id).toBe(containerAAgentId);
          expect(extractText(msg)).toContain("ECHO:");
        }

        aliceClient.close();
      }, 120_000);
    });

    // --- Two agents in separate containers ---

    it("two agents: both receive and reply from their own containers", async () => {
      const alice = await registerAndClaim("2a-alice");
      await makeContact(alice.userId, containerAUserId);
      await makeContact(alice.userId, containerBUserId);

      const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
      await aliceClient.connect(alice.apiKey);

      const convAId = extractConvId(
        await aliceClient.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: containerAAgentId }],
        }),
      );

      const convBId = extractConvId(
        await aliceClient.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: containerBAgentId }],
        }),
      );

      const reply1 = aliceClient.waitForEvent("messages/received", 60_000);
      const reply2 = aliceClient.waitForEvent("messages/received", 60_000);

      await aliceClient.rpc("messages/send", {
        conversationId: convAId,
        parts: [{ type: "text", text: "hello container-a" }],
      });
      await aliceClient.rpc("messages/send", {
        conversationId: convBId,
        parts: [{ type: "text", text: "hello container-b" }],
      });

      const events = await Promise.all([reply1, reply2]);
      const messages = events.map((e) => extractMessage(e));

      const aMsg = messages.find((m) => m.conversationId === convAId);
      const bMsg = messages.find((m) => m.conversationId === convBId);

      expect(aMsg).toBeDefined();
      expect(bMsg).toBeDefined();
      expect(aMsg!.sender.id).toBe(containerAAgentId);
      expect(bMsg!.sender.id).toBe(containerBAgentId);
      expect(extractText(aMsg!)).toContain("ECHO:");
      expect(extractText(bMsg!)).toContain("ECHO:");

      aliceClient.close();
    }, 180_000);

    // --- Human -> Agent (control channel) ---

    describe("human -> agent via control channel", () => {
      it("human sends to control channel, OpenClaw replies to human", async () => {
        const humanClient = new MoltZapTestClient(baseUrl, wsUrl);
        await humanClient.connectJwt(containerASupabaseUid);

        const convId = extractConvId(
          await humanClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        const replyPromise = humanClient.waitForEvent(
          "messages/received",
          60_000,
        );

        await humanClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "hello from human" }],
        });

        const reply = extractMessage(await replyPromise);
        expect(reply.parts.length).toBeGreaterThan(0);
        expect(reply.conversationId).toBe(convId);
        expect(reply.sender.id).toBe(containerAAgentId);
        expect(reply.sender.type).toBe("agent");
        expect(extractText(reply)).toContain("ECHO:");

        humanClient.close();
      }, 90_000);

      it("agent reply has correct sender identity", async () => {
        const humanClient = new MoltZapTestClient(baseUrl, wsUrl);
        await humanClient.connectJwt(containerASupabaseUid);

        const convId = extractConvId(
          await humanClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        const replyPromise = humanClient.waitForEvent(
          "messages/received",
          60_000,
        );

        await humanClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "who are you?" }],
        });

        const reply = extractMessage(await replyPromise);
        expect(reply.sender.type).toBe("agent");
        expect(reply.sender.id).toBe(containerAAgentId);
        expect(extractText(reply)).toContain("ECHO:");

        humanClient.close();
      }, 90_000);
    });

    // --- Aggressive scenarios ---

    describe("outbound proactive messaging", () => {
      it("agent proactively sends to agent:<name>, DM auto-created, message arrives", async () => {
        const receiver = await registerAndClaim("out-receiver-pro");
        await makeContact(containerAUserId, receiver.userId);

        const receiverClient = new MoltZapTestClient(baseUrl, wsUrl);
        await receiverClient.connect(receiver.apiKey);

        const msgPromise = receiverClient.waitForEvent(
          "messages/received",
          60_000,
        );

        const senderClient = new MoltZapTestClient(baseUrl, wsUrl);
        await senderClient.connect(inject("containerAApiKey"));

        const lookupResult = (await senderClient.rpc("agents/lookupByName", {
          names: ["out-receiver-pro"],
        })) as { agents: { id: string }[] };

        const convId = extractConvId(
          await senderClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: lookupResult.agents[0]!.id }],
          }),
        );

        await senderClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "proactive hello" }],
        });

        const received = extractMessage(await msgPromise);
        expect(received.sender.id).toBe(containerAAgentId);
        expect(extractText(received)).toBe("proactive hello");
        expect(received.conversationId).toBe(convId);

        senderClient.close();
        receiverClient.close();
      }, 90_000);

      it("second message to same agent reuses conversation (no duplicate)", async () => {
        const receiver = await registerAndClaim("out-receiver-dup");
        await makeContact(containerAUserId, receiver.userId);

        const receiverClient = new MoltZapTestClient(baseUrl, wsUrl);
        await receiverClient.connect(receiver.apiKey);

        const senderClient = new MoltZapTestClient(baseUrl, wsUrl);
        await senderClient.connect(inject("containerAApiKey"));

        const lookupResult = (await senderClient.rpc("agents/lookupByName", {
          names: ["out-receiver-dup"],
        })) as { agents: { id: string }[] };

        const convId1 = extractConvId(
          await senderClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: lookupResult.agents[0]!.id }],
          }),
        );

        const msg1Promise = receiverClient.waitForEvent(
          "messages/received",
          60_000,
        );
        await senderClient.rpc("messages/send", {
          conversationId: convId1,
          parts: [{ type: "text", text: "first" }],
        });
        const msg1 = extractMessage(await msg1Promise);

        const msg2Promise = receiverClient.waitForEvent(
          "messages/received",
          60_000,
        );
        await senderClient.rpc("messages/send", {
          conversationId: convId1,
          parts: [{ type: "text", text: "second" }],
        });
        const msg2 = extractMessage(await msg2Promise);

        expect(msg1.conversationId).toBe(convId1);
        expect(msg2.conversationId).toBe(convId1);

        senderClient.close();
        receiverClient.close();
      }, 90_000);
    });

    describe("error scenarios", () => {
      it("send to nonexistent agent returns error", async () => {
        const agent = await registerAndClaim("err-sender");
        const agentClient = new MoltZapTestClient(baseUrl, wsUrl);
        await agentClient.connect(agent.apiKey);

        await expect(
          agentClient.rpc("agents/lookupByName", {
            name: "nonexistent-agent-xyz",
          }),
        ).rejects.toThrow();

        agentClient.close();
      }, 30_000);

      it("large message (>4096 chars) is delivered intact", async () => {
        const alice = await registerAndClaim("lg-alice");
        await makeContact(alice.userId, containerAUserId);

        const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient.connect(alice.apiKey);

        const convId = extractConvId(
          await aliceClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        const largeText = "A".repeat(5000);

        const replyPromise = aliceClient.waitForEvent(
          "messages/received",
          60_000,
        );

        await aliceClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: largeText }],
        });

        const reply = extractMessage(await replyPromise);
        expect(reply.conversationId).toBe(convId);
        expect(reply.sender.id).toBe(containerAAgentId);
        const replyText = extractText(reply);
        expect(replyText).toContain("ECHO:");
        expect(replyText.length).toBeGreaterThan(4096);

        aliceClient.close();
      }, 120_000);

      it("reconnection during dispatch: message recovery after WebSocket drop", async () => {
        const alice = await registerAndClaim("rd-alice");
        await makeContact(alice.userId, containerAUserId);

        const aliceClient = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient.connect(alice.apiKey);

        const convId = extractConvId(
          await aliceClient.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: containerAAgentId }],
          }),
        );

        // Send first message to verify baseline works
        const reply1Promise = aliceClient.waitForEvent(
          "messages/received",
          60_000,
        );
        await aliceClient.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "before drop" }],
        });
        const reply1 = extractMessage(await reply1Promise);
        expect(extractText(reply1)).toContain("ECHO:");

        // Close and reconnect alice's WebSocket
        aliceClient.close();

        await new Promise((r) => setTimeout(r, 1000));

        const aliceClient2 = new MoltZapTestClient(baseUrl, wsUrl);
        await aliceClient2.connect(alice.apiKey);

        // Send message after reconnection
        const reply2Promise = aliceClient2.waitForEvent(
          "messages/received",
          60_000,
        );
        await aliceClient2.rpc("messages/send", {
          conversationId: convId,
          parts: [{ type: "text", text: "after reconnect" }],
        });
        const reply2 = extractMessage(await reply2Promise);
        expect(extractText(reply2)).toContain("ECHO:");
        expect(reply2.conversationId).toBe(convId);

        aliceClient2.close();
      }, 120_000);
    });
  },
);
