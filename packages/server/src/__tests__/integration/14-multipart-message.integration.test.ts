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

describe("Multipart Message", () => {
  it("message with multiple text parts preserves all parts in order", async () => {
    const { alice, bob } = await setupAgentPair();

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    const parts = [
      { type: "text" as const, text: "Part 1: Introduction" },
      { type: "text" as const, text: "Part 2: Main content" },
      { type: "text" as const, text: "Part 3: Conclusion" },
    ];

    // Set up Bob's event waiter BEFORE send
    const bobEventPromise = bob.client.waitForEvent("messages/received");

    const sendResult = (await alice.client.rpc("messages/send", {
      conversationId,
      parts,
    })) as {
      message: { parts: Array<{ type: string; text: string }> };
    };

    expect(sendResult.message.parts).toHaveLength(3);
    expect(sendResult.message.parts).toEqual(parts);

    const bobEvent = await bobEventPromise;
    const received = (
      bobEvent.data as {
        message: { parts: Array<{ type: string; text: string }> };
      }
    ).message;

    expect(received.parts).toHaveLength(3);
    expect(received.parts[0]!.text).toBe("Part 1: Introduction");
    expect(received.parts[1]!.text).toBe("Part 2: Main content");
    expect(received.parts[2]!.text).toBe("Part 3: Conclusion");

    // Verify via message listing
    const history = (await bob.client.rpc("messages/list", {
      conversationId,
    })) as {
      messages: Array<{ parts: Array<{ type: string; text: string }> }>;
    };
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]!.parts).toEqual(parts);
  });
});
