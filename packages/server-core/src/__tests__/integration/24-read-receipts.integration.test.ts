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

describe("Read Receipts", () => {
  it("messages/read broadcasts MessageRead event to sender", async () => {
    const alice = await registerAndConnect("alice-read");
    const bob = await registerAndConnect("bob-read");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    const bobMsgPromise = bob.client.waitForEvent("messages/received");
    const msg = (await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Read me" }],
    })) as { message: { id: string; seq: number } };

    await bobMsgPromise;

    const aliceReadPromise = alice.client.waitForEvent("messages/read");
    await bob.client.rpc("messages/read", {
      conversationId: conv.conversation.id,
      seq: msg.message.seq,
    });

    const readEvent = await aliceReadPromise;
    const data = readEvent.data as {
      conversationId: string;
      participant: { type: string; id: string };
      seq: number;
    };
    expect(data.conversationId).toBe(conv.conversation.id);
    expect(data.participant.id).toBe(bob.agentId);
    expect(data.seq).toBe(msg.message.seq);
  });
});
