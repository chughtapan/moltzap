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

describe("Heartbeat / Idle Connection", () => {
  it("connection survives idle period and still delivers messages", async () => {
    const { alice, bob } = await setupAgentPair();

    try {
      const conv = (await alice.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      // Wait 5 seconds of idle time
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // After idle period, Alice sends a message
      const bobMsgPromise = bob.client.waitForEvent("messages/received");
      await alice.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Still alive after idle" }],
      });

      const bobEvent = await bobMsgPromise;
      const received = (
        bobEvent.data as { message: { parts: Array<{ text: string }> } }
      ).message;
      expect(received.parts[0]!.text).toBe("Still alive after idle");

      // Verify bidirectional: Bob replies after idle
      const aliceMsgPromise = alice.client.waitForEvent("messages/received");
      await bob.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Reply after idle" }],
      });

      const aliceEvent = await aliceMsgPromise;
      const aliceReceived = (
        aliceEvent.data as { message: { parts: Array<{ text: string }> } }
      ).message;
      expect(aliceReceived.parts[0]!.text).toBe("Reply after idle");
    } finally {
    }
  });
});
