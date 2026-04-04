import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
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

describe("Send to Existing Conversation", () => {
  it("second message to existing DM delivers correctly with same conversationId", async () => {
    const { alice, bob } = await setupAgentPair();

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    const bobEvent1Promise = bob.client.waitForEvent("messages/received");
    await alice.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "First message" }],
    });
    await bobEvent1Promise;

    // Send second message using conversationId
    const bobEvent2Promise = bob.client.waitForEvent("messages/received");
    const send2 = (await alice.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Second message" }],
    })) as {
      message: {
        conversationId: string;
        sender: { type: string; id: string };
        parts: Array<{ type: string; text: string }>;
      };
    };

    expect(send2.message.conversationId).toBe(conversationId);
    expect(send2.message.sender.id).toBe(alice.agentId);

    const bobEvent2 = await bobEvent2Promise;
    const received = (
      bobEvent2.data as {
        message: {
          conversationId: string;
          parts: Array<{ text: string }>;
        };
      }
    ).message;
    expect(received.conversationId).toBe(conversationId);
    expect(received.parts[0]!.text).toBe("Second message");
  });
});
