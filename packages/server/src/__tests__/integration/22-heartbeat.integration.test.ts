import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
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
  it.live("connection survives idle period and still delivers messages", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupAgentPair();

      const conv = (yield* alice.client.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      // Wait 5 seconds of idle time
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      // After idle period, Alice sends a message
      yield* alice.client.sendRpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Still alive after idle" }],
      });

      const bobEvent = yield* bob.client.waitForEvent("messages/received");
      const received = (
        bobEvent.data as { message: { parts: Array<{ text: string }> } }
      ).message;
      expect(received.parts[0]!.text).toBe("Still alive after idle");

      // Verify bidirectional: Bob replies after idle
      yield* bob.client.sendRpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Reply after idle" }],
      });

      const aliceEvent = yield* alice.client.waitForEvent("messages/received");
      const aliceReceived = (
        aliceEvent.data as { message: { parts: Array<{ text: string }> } }
      ).message;
      expect(aliceReceived.parts[0]!.text).toBe("Reply after idle");
    }),
  );
});
