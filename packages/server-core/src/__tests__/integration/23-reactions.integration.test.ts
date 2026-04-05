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

describe("Reactions", () => {
  it("add reaction broadcasts event to conversation participants", async () => {
    const alice = await registerAndConnect("alice-react");
    const bob = await registerAndConnect("bob-react");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    const msg = (await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "React to this" }],
    })) as { message: { id: string } };

    const bobReactPromise = bob.client.waitForEvent("messages/reacted");
    await alice.client.rpc("messages/react", {
      messageId: msg.message.id,
      emoji: "👍",
      action: "add",
    });

    const reactEvent = await bobReactPromise;
    const data = reactEvent.data as {
      messageId: string;
      emoji: string;
      action: string;
    };
    expect(data.messageId).toBe(msg.message.id);
    expect(data.emoji).toBe("👍");
    expect(data.action).toBe("add");
  });

  it("remove reaction broadcasts event", async () => {
    const alice = await registerAndConnect("alice-unreact");
    const bob = await registerAndConnect("bob-unreact");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    const msg = (await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Unreact test" }],
    })) as { message: { id: string } };

    await alice.client.rpc("messages/react", {
      messageId: msg.message.id,
      emoji: "🔥",
      action: "add",
    });
    await bob.client.waitForEvent("messages/reacted");

    const bobRemovePromise = bob.client.waitForEvent("messages/reacted");
    await alice.client.rpc("messages/react", {
      messageId: msg.message.id,
      emoji: "🔥",
      action: "remove",
    });

    const removeEvent = await bobRemovePromise;
    const data = removeEvent.data as { action: string; emoji: string };
    expect(data.action).toBe("remove");
    expect(data.emoji).toBe("🔥");
  });
});
