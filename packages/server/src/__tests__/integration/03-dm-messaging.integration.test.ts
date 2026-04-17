import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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

describe("Scenario 3: DM Messaging", () => {
  it.live("send and receive a DM, list messages", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-dm");
      const bob = yield* registerAndConnect("bob-dm");

      // Alice creates a DM conversation with Bob
      const conv = (yield* alice.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string; type: string } };

      expect(conv.conversation.type).toBe("dm");
      const conversationId = conv.conversation.id;

      // Alice sends a message
      const sendResult = (yield* alice.client.sendRpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Hello Bob!" }],
      })) as { message: { id: string; parts: unknown[] } };

      expect(sendResult.message.id).toBeDefined();
      expect(sendResult.message.parts).toEqual([
        { type: "text", text: "Hello Bob!" },
      ]);

      // Alice lists messages
      const messages = (yield* alice.client.sendRpc("messages/list", {
        conversationId,
      })) as { messages: Array<{ id: string; parts: unknown[] }> };

      expect(messages.messages).toHaveLength(1);
      expect(messages.messages[0]!.id).toBe(sendResult.message.id);

      // Verify message is encrypted in DB
      const db = getKyselyDb();
      const dbRow = yield* Effect.tryPromise(() =>
        db
          .selectFrom("messages")
          .select(["parts_encrypted", "parts_iv", "parts_tag"])
          .where("id", "=", sendResult.message.id)
          .executeTakeFirstOrThrow(),
      );

      expect(dbRow.parts_iv).toBeDefined();
      expect(dbRow.parts_tag).toBeDefined();

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});
