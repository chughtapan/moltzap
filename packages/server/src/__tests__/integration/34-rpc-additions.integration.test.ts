import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
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

describe("Scenario 34: apps/register + system/ping RPCs", () => {
  describe("system/ping", () => {
    it("returns an ISO8601 ts string", async () => {
      const agent = await registerAndConnect("alice");

      const result = (await agent.client.rpc("system/ping", {})) as {
        ts: string;
      };

      expect(typeof result.ts).toBe("string");
      // ISO 8601 with milliseconds + Z
      expect(result.ts).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      // ts is recent (within last minute)
      expect(Date.now() - Date.parse(result.ts)).toBeLessThan(60_000);
    });
  });

  describe("apps/register", () => {
    it("registers a valid manifest and returns the appId", async () => {
      const agent = await registerAndConnect("alice");

      const result = (await agent.client.rpc("apps/register", {
        manifest: {
          appId: "my-test-app",
          name: "My Test App",
          permissions: { required: [], optional: [] },
          conversations: [
            { key: "main", name: "Main", participantFilter: "all" },
          ],
        },
      })) as { appId: string };

      expect(result.appId).toBe("my-test-app");
    });

    it("rejects a manifest missing required fields", async () => {
      const agent = await registerAndConnect("alice");

      await expect(
        agent.client.rpc("apps/register", {
          manifest: { appId: "broken" },
        }),
      ).rejects.toThrow();
    });

    it("rejects calls missing the manifest param entirely", async () => {
      const agent = await registerAndConnect("alice");

      await expect(agent.client.rpc("apps/register", {})).rejects.toThrow();
    });
  });

  describe("messages/send with replyToId only", () => {
    it("resolves conversationId from replyToId when caller omits conversationId", async () => {
      const { alice, bob } = await setupAgentPair();

      const conv = (await alice.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      const sent = (await alice.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "question" }],
      })) as { message: { id: string } };

      // Bob replies using replyToId only — server must resolve the conversation
      const replied = (await bob.client.rpc("messages/send", {
        replyToId: sent.message.id,
        parts: [{ type: "text", text: "answer" }],
      })) as {
        message: { conversationId: string; replyToId?: string };
      };

      expect(replied.message.conversationId).toBe(conversationId);
      expect(replied.message.replyToId).toBe(sent.message.id);
    });

    it("rejects when replyToId points to an unknown message", async () => {
      const agent = await registerAndConnect("alice");
      const unknownId = "00000000-0000-0000-0000-000000000000";
      await expect(
        agent.client.rpc("messages/send", {
          replyToId: unknownId,
          parts: [{ type: "text", text: "orphan" }],
        }),
      ).rejects.toThrow();
    });
  });
});
