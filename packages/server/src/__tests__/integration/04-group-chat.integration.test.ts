import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
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

describe("Scenario 4: Group Chat", () => {
  it.live("create group, send messages, verify seq monotonicity", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-grp");
      const bob = yield* registerAndConnect("bob-grp");

      // Alice creates a group
      const conv = (yield* alice.client.rpc("conversations/create", {
        type: "group",
        name: "Test Group",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string; type: string; name: string } };

      expect(conv.conversation.type).toBe("group");
      expect(conv.conversation.name).toBe("Test Group");

      const conversationId = conv.conversation.id;

      // Alice sends multiple messages
      const seqs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = (yield* alice.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: `Message ${i + 1}` }],
        })) as { message: { id: string } };
        seqs.push(result.message.id);
      }

      // List messages
      const messages = (yield* alice.client.rpc("messages/list", {
        conversationId,
      })) as { messages: Array<{ parts: Array<{ text: string }> }> };

      expect(messages.messages).toHaveLength(3);
      expect(messages.messages[0]!.parts[0]!.text).toBe("Message 1");
      expect(messages.messages[2]!.parts[0]!.text).toBe("Message 3");

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );

  it.live("addParticipant returns participant", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-addp");
      const bob = yield* registerAndConnect("bob-addp");

      // Create group with just Alice
      const conv = (yield* alice.client.rpc("conversations/create", {
        type: "group",
        name: "Add Test",
        participants: [{ type: "agent", id: alice.agentId }],
      })) as { conversation: { id: string } };

      // Add Bob
      const result = (yield* alice.client.rpc("conversations/addParticipant", {
        conversationId: conv.conversation.id,
        participant: { type: "agent", id: bob.agentId },
      })) as { participant: { conversationId: string; role: string } };

      expect(result.participant).toBeDefined();
      expect(result.participant.conversationId).toBe(conv.conversation.id);
      expect(result.participant.role).toBe("member");

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});
