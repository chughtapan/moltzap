import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestServer, stopTestServer, resetTestDb } from "./helpers.js";
import { registerAndConnect } from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Message Deletion", () => {
  it("messages/delete broadcasts MessageDeleted and excludes from history", async () => {
    const alice = await registerAndConnect("alice-del");
    const bob = await registerAndConnect("bob-del");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    await bob.client.waitForEvent("conversations/created");

    const msg = (await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Delete me" }],
    })) as { message: { id: string } };

    await bob.client.waitForEvent("messages/received");

    const bobDeletePromise = bob.client.waitForEvent("messages/deleted");
    await alice.client.rpc("messages/delete", {
      messageId: msg.message.id,
    });

    const deleteEvent = await bobDeletePromise;
    const data = deleteEvent.data as {
      messageId: string;
      conversationId: string;
    };
    expect(data.messageId).toBe(msg.message.id);
    expect(data.conversationId).toBe(conv.conversation.id);

    // Deleted message should not appear in history
    const history = (await alice.client.rpc("messages/list", {
      conversationId: conv.conversation.id,
    })) as { messages: Array<{ id: string }> };
    expect(
      history.messages.find((m) => m.id === msg.message.id),
    ).toBeUndefined();
  });
});
