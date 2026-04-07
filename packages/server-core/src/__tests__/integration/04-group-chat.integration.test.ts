import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
  it("create group, send messages, verify seq monotonicity", async () => {
    const alice = await registerAndConnect("alice-grp");
    const bob = await registerAndConnect("bob-grp");

    // Alice creates a group
    const conv = (await alice.client.rpc("conversations/create", {
      type: "group",
      name: "Test Group",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string; name: string } };

    expect(conv.conversation.type).toBe("group");
    expect(conv.conversation.name).toBe("Test Group");

    const conversationId = conv.conversation.id;

    // Alice sends multiple messages
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = (await alice.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: `Message ${i + 1}` }],
      })) as { message: { seq: number } };
      seqs.push(result.message.seq);
    }

    // Verify seq monotonicity
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }

    // List messages
    const messages = (await alice.client.rpc("messages/list", {
      conversationId,
    })) as { messages: Array<{ parts: Array<{ text: string }> }> };

    expect(messages.messages).toHaveLength(3);
    expect(messages.messages[0]!.parts[0]!.text).toBe("Message 1");
    expect(messages.messages[2]!.parts[0]!.text).toBe("Message 3");

    alice.client.close();
    bob.client.close();
  });

  it("addParticipant returns participant", async () => {
    const alice = await registerAndConnect("alice-addp");
    const bob = await registerAndConnect("bob-addp");

    // Create group with just Alice
    const conv = (await alice.client.rpc("conversations/create", {
      type: "group",
      name: "Add Test",
      participants: [{ type: "agent", id: alice.agentId }],
    })) as { conversation: { id: string } };

    // Add Bob
    const result = (await alice.client.rpc("conversations/addParticipant", {
      conversationId: conv.conversation.id,
      participant: { type: "agent", id: bob.agentId },
    })) as { participant: { conversationId: string; role: string } };

    expect(result.participant).toBeDefined();
    expect(result.participant.conversationId).toBe(conv.conversation.id);
    expect(result.participant.role).toBe("member");

    alice.client.close();
    bob.client.close();
  });
});
