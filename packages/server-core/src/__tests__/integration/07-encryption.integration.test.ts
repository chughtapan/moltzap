import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  getKyselyDb,
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

describe("Scenario 7: Encryption", () => {
  it("message parts are encrypted in DB, IV and tag have correct lengths", async () => {
    const { client, agentId } = await registerAndConnect("enc-agent");

    // Create conversation
    const conv = (await client.rpc("conversations/create", {
      type: "group",
      name: "Enc Test",
      participants: [{ type: "agent", id: agentId }],
    })) as { conversation: { id: string } };

    // Send a message
    const msg = (await client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "This should be encrypted" }],
    })) as { message: { id: string } };

    // Check DB directly via Kysely
    const db = getKyselyDb();
    const row = await db
      .selectFrom("messages")
      .select([
        "parts_encrypted",
        "parts_iv",
        "parts_tag",
        "dek_version",
        "kek_version",
      ])
      .where("id", "=", msg.message.id)
      .executeTakeFirstOrThrow();

    const encrypted = row.parts_encrypted as Buffer;
    const iv = row.parts_iv as Buffer;
    const tag = row.parts_tag as Buffer;

    // IV should be 12 bytes (AES-GCM standard)
    expect(iv.length).toBe(12);
    // Auth tag should be 16 bytes
    expect(tag.length).toBe(16);
    // DEK and KEK versions should be set
    expect(row.dek_version).toBeGreaterThanOrEqual(1);
    expect(row.kek_version).toBeGreaterThanOrEqual(1);

    // Encrypted data should NOT contain plaintext
    const rawStr = encrypted.toString("utf-8");
    expect(rawStr).not.toContain("This should be encrypted");

    // But we can still decrypt it via the API
    const messages = (await client.rpc("messages/list", {
      conversationId: conv.conversation.id,
    })) as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(messages.messages[0]!.parts[0]!.text).toBe(
      "This should be encrypted",
    );

    // Verify conversation key was created
    const convKey = await db
      .selectFrom("conversation_keys")
      .selectAll()
      .where("conversation_id", "=", conv.conversation.id)
      .execute();
    expect(convKey.length).toBeGreaterThanOrEqual(1);

    client.close();
  });
});
