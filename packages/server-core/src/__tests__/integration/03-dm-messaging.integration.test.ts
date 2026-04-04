import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
} from "./helpers.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Scenario 3: DM Messaging", () => {
  it("send and receive a DM, list messages", async () => {
    const alice = await registerAndConnect("alice-dm");
    const bob = await registerAndConnect("bob-dm");

    // Alice creates a DM conversation with Bob
    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string } };

    expect(conv.conversation.type).toBe("dm");
    const conversationId = conv.conversation.id;

    // Alice sends a message
    const sendResult = (await alice.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Hello Bob!" }],
    })) as { message: { id: string; seq: number; parts: unknown[] } };

    expect(sendResult.message.id).toBeDefined();
    expect(sendResult.message.seq).toBeGreaterThan(0);
    expect(sendResult.message.parts).toEqual([
      { type: "text", text: "Hello Bob!" },
    ]);

    // Alice lists messages
    const messages = (await alice.client.rpc("messages/list", {
      conversationId,
    })) as { messages: Array<{ id: string; parts: unknown[] }> };

    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]!.id).toBe(sendResult.message.id);

    // Verify message is encrypted in DB
    const db = getKyselyDb();
    const dbRow = await db
      .selectFrom("messages")
      .select(["parts_encrypted", "parts_iv", "parts_tag"])
      .where("id", "=", sendResult.message.id)
      .executeTakeFirstOrThrow();

    expect(dbRow.parts_iv).toBeDefined();
    expect(dbRow.parts_tag).toBeDefined();

    // Mark as read
    await alice.client.rpc("messages/read", {
      conversationId,
      seq: sendResult.message.seq,
    });

    alice.client.close();
    bob.client.close();
  });
});
