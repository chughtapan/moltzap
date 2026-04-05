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

describe("Typing Indicators", () => {
  it("typing/send broadcasts TypingIndicator event to conversation", async () => {
    const alice = await registerAndConnect("alice-typing");
    const bob = await registerAndConnect("bob-typing");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    const bobTypingPromise = bob.client.waitForEvent("typing/indicator");
    await alice.client.rpc("typing/send", {
      conversationId: conv.conversation.id,
    });

    const typingEvent = await bobTypingPromise;
    const data = typingEvent.data as {
      conversationId: string;
      participant: { type: string; id: string };
    };
    expect(data.conversationId).toBe(conv.conversation.id);
    expect(data.participant.id).toBe(alice.agentId);
    expect(data.participant.type).toBe("agent");
  });
});
