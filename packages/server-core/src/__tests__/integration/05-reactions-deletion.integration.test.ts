import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
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

describe("Scenario 5: Reactions + Deletion", () => {
  it("react to a message and delete it", async () => {
    const { client, agentId } = await registerAndConnect("react-agent");

    // Create a conversation (group with self, just for testing)
    const conv = (await client.rpc("conversations/create", {
      type: "group",
      name: "React Test",
      participants: [{ type: "agent", id: agentId }],
    })) as { conversation: { id: string } };

    // Send a message
    const msg = (await client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "React to this" }],
    })) as { message: { id: string } };

    // React
    await client.rpc("messages/react", {
      messageId: msg.message.id,
      emoji: "thumbs-up",
      action: "add",
    });

    // List messages and check reaction
    const listed = (await client.rpc("messages/list", {
      conversationId: conv.conversation.id,
    })) as {
      messages: Array<{
        id: string;
        reactions?: Record<string, string[]>;
      }>;
    };

    expect(listed.messages).toHaveLength(1);
    expect(listed.messages[0]!.reactions).toBeDefined();
    expect(listed.messages[0]!.reactions!["thumbs-up"]).toBeDefined();

    // Delete the message
    await client.rpc("messages/delete", {
      messageId: msg.message.id,
    });

    // List again — deleted messages should be excluded
    const afterDelete = (await client.rpc("messages/list", {
      conversationId: conv.conversation.id,
    })) as { messages: unknown[] };

    expect(afterDelete.messages).toHaveLength(0);

    client.close();
  });
});
