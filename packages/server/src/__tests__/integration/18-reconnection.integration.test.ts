import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentPair,
} from "./helpers.js";
import { MoltZapTestClient } from "@moltzap/protocol/test-client";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const urls = await startTestServer();
  baseUrl = urls.baseUrl;
  wsUrl = urls.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Reconnection", () => {
  it.live(
    "agent reconnects and retrieves messages sent while disconnected",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        let bobClient2: MoltZapTestClient | null = null;

        try {
          const conv = (yield* alice.client.rpc("conversations/create", {
            type: "dm",
            participants: [{ type: "agent", id: bob.agentId }],
          })) as { conversation: { id: string } };
          const conversationId = conv.conversation.id;

          yield* alice.client.rpc("messages/send", {
            conversationId,
            parts: [{ type: "text", text: "Pre-disconnect" }],
          });
          yield* bob.client.waitForEvent("messages/received");

          // Bob disconnects
          yield* bob.client.close();

          // Alice sends a message while Bob is offline
          yield* alice.client.rpc("messages/send", {
            conversationId,
            parts: [{ type: "text", text: "Sent while you were away" }],
          });

          // Bob reconnects with the same API key
          bobClient2 = new MoltZapTestClient(baseUrl, wsUrl);
          yield* bobClient2.connect(bob.apiKey);

          // Bob fetches messages — should see both
          const msgs = (yield* bobClient2.rpc("messages/list", {
            conversationId,
          })) as {
            messages: Array<{ parts: Array<{ text: string }> }>;
          };

          expect(msgs.messages).toHaveLength(2);
          expect(msgs.messages[0]!.parts[0]!.text).toBe("Pre-disconnect");
          expect(msgs.messages[1]!.parts[0]!.text).toBe(
            "Sent while you were away",
          );

          // Verify real-time messaging works after reconnect
          yield* bobClient2.rpc("messages/send", {
            conversationId,
            parts: [{ type: "text", text: "I am back online" }],
          });

          const aliceEvent =
            yield* alice.client.waitForEvent("messages/received");
          const received = (
            aliceEvent.data as { message: { parts: Array<{ text: string }> } }
          ).message;
          expect(received.parts[0]!.text).toBe("I am back online");
        } finally {
          if (bobClient2) yield* bobClient2.close();
        }
      }),
  );
});
