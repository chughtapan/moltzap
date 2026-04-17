import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentGroup,
} from "./helpers.js";
import type { ConnectedAgent } from "./helpers.js";

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Mute and Unmute", () => {
  it.live(
    "muted participant does not receive messages, unmuted participant does",
    () =>
      Effect.gen(function* () {
        const group = yield* setupAgentGroup(3, {
          groupName: "Mute Test",
        });
        const [alice, bob, eve] = group.agents as [
          ConnectedAgent,
          ConnectedAgent,
          ConnectedAgent,
        ];
        const conversationId = group.conversationId!;

        // Alice mutes the conversation
        yield* alice.client.rpc("conversations/mute", { conversationId });

        // Bob sends a message — Eve should receive, Alice should NOT
        yield* bob.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: "Alice is muted" }],
        });
        yield* eve.client.waitForEvent("messages/received");

        // Wait for any stray events to arrive, then verify Alice got nothing
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)));
        const aliceMutedEvents = alice.client
          .drainEvents()
          .filter((e) => e.event === "messages/received");
        expect(aliceMutedEvents).toHaveLength(0);

        // Alice unmutes
        yield* alice.client.rpc("conversations/unmute", { conversationId });

        // Bob sends another message — Alice SHOULD receive it now
        yield* bob.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: "Alice is back" }],
        });
        const aliceEvent =
          yield* alice.client.waitForEvent("messages/received");
        expect(
          (aliceEvent.data as { message: { parts: Array<{ text: string }> } })
            .message.parts[0]!.text,
        ).toBe("Alice is back");
      }),
  );
});
