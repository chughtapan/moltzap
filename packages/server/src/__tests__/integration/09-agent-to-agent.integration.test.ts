import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
} from "./helpers.js";

let _baseUrl: string;
let _wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  _baseUrl = server.baseUrl;
  _wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Scenario 1: Full Agent-to-Agent DM Flow", () => {
  it.live(
    "both agents connect first, then create DM and exchange messages",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-a2a");
        const bob = yield* registerAndConnect("bob-a2a");

        // Alice creates DM — server subscribes Bob's already-open connection
        const conv = (yield* alice.client.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string; type: string } };
        expect(conv.conversation.type).toBe("dm");
        const conversationId = conv.conversation.id;

        // Set up waiter before send
        yield* alice.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: "Hello Bob!" }],
        });
        const bobEvent = yield* bob.client.waitForEvent("messages/received");
        expect(
          (bobEvent.data as { message: { parts: Array<{ text: string }> } })
            .message.parts[0]!.text,
        ).toBe("Hello Bob!");

        yield* bob.client.rpc("messages/send", {
          conversationId,
          parts: [{ type: "text", text: "Hey Alice!" }],
        });
        const aliceEvent =
          yield* alice.client.waitForEvent("messages/received");
        expect(
          (aliceEvent.data as { message: { parts: Array<{ text: string }> } })
            .message.parts[0]!.text,
        ).toBe("Hey Alice!");

        // Both list messages
        const msgs = (yield* alice.client.rpc("messages/list", {
          conversationId,
        })) as {
          messages: Array<{ parts: Array<{ text: string }> }>;
        };
        expect(msgs.messages).toHaveLength(2);
        expect(msgs.messages[0]!.parts[0]!.text).toBe("Hello Bob!");
        expect(msgs.messages[1]!.parts[0]!.text).toBe("Hey Alice!");

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );
});

describe("Scenario 5: Group Chat Fan-Out", () => {
  it.live("messages fan out to all group participants", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-fan");
      const bob = yield* registerAndConnect("bob-fan");
      const eve = yield* registerAndConnect("eve-fan");

      const conv = (yield* alice.client.rpc("conversations/create", {
        type: "group",
        name: "Team Chat",
        participants: [
          { type: "agent", id: bob.agentId },
          { type: "agent", id: eve.agentId },
        ],
      })) as { conversation: { id: string } };
      const conversationId = conv.conversation.id;

      // Set up waiters before send
      yield* alice.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "Team standup" }],
      });

      const bobEvent = yield* bob.client.waitForEvent("messages/received");
      const eveEvent = yield* eve.client.waitForEvent("messages/received");
      expect(
        (bobEvent.data as { message: { parts: Array<{ text: string }> } })
          .message.parts[0]!.text,
      ).toBe("Team standup");
      expect(
        (eveEvent.data as { message: { parts: Array<{ text: string }> } })
          .message.parts[0]!.text,
      ).toBe("Team standup");

      // Set up waiters for Bob's reply
      yield* bob.client.rpc("messages/send", {
        conversationId,
        parts: [{ type: "text", text: "All clear" }],
      });

      const aliceReply = yield* alice.client.waitForEvent("messages/received");
      const eveReply = yield* eve.client.waitForEvent("messages/received");
      expect(
        (aliceReply.data as { message: { parts: Array<{ text: string }> } })
          .message.parts[0]!.text,
      ).toBe("All clear");
      expect(
        (eveReply.data as { message: { parts: Array<{ text: string }> } })
          .message.parts[0]!.text,
      ).toBe("All clear");

      yield* alice.client.close();
      yield* bob.client.close();
      yield* eve.client.close();
    }),
  );
});

describe("Regression: conversations/create subscribes connected participants", () => {
  it.live(
    "participant connected before conversation creation receives messages without reconnecting",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-sub");
        const bob = yield* registerAndConnect("bob-sub");

        // Bob is already connected when Alice creates the DM
        const conv = (yield* alice.client.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        // Bob should receive the ConversationCreated event
        const createdEvent = yield* bob.client.waitForEvent(
          "conversations/created",
        );
        expect(createdEvent).toBeDefined();

        // Bob should also receive messages WITHOUT reconnecting
        yield* alice.client.rpc("messages/send", {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "No reconnect needed" }],
        });
        const msgEvent = yield* bob.client.waitForEvent("messages/received");
        expect(
          (msgEvent.data as { message: { parts: Array<{ text: string }> } })
            .message.parts[0]!.text,
        ).toBe("No reconnect needed");

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );
});

describe("Regression: waitForEvent does not double-consume buffered events", () => {
  it.live(
    "sequential waitForEvent calls return distinct events, not duplicates",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-buf");
        const bob = yield* registerAndConnect("bob-buf");

        const conv = (yield* alice.client.rpc("conversations/create", {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        })) as { conversation: { id: string } };

        // Set up waiter for first message
        yield* alice.client.rpc("messages/send", {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "First" }],
        });
        const msg1 = yield* bob.client.waitForEvent("messages/received");
        expect(
          (msg1.data as { message: { parts: Array<{ text: string }> } }).message
            .parts[0]!.text,
        ).toBe("First");

        // Set up waiter for second message — must NOT return "First" again
        yield* alice.client.rpc("messages/send", {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "Second" }],
        });
        const msg2 = yield* bob.client.waitForEvent("messages/received");
        expect(
          (msg2.data as { message: { parts: Array<{ text: string }> } }).message
            .parts[0]!.text,
        ).toBe("Second");

        yield* alice.client.close();
        yield* bob.client.close();
      }),
  );
});

describe("Regression: messages/send excludes sender from broadcast", () => {
  it.live("sender does not receive their own message as an event", () =>
    Effect.gen(function* () {
      const alice = yield* registerAndConnect("alice-noecho");
      const bob = yield* registerAndConnect("bob-noecho");

      const conv = (yield* alice.client.rpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: bob.agentId }],
      })) as { conversation: { id: string } };

      // Bob waits for the message

      // Alice sends
      yield* alice.client.rpc("messages/send", {
        conversationId: conv.conversation.id,
        parts: [{ type: "text", text: "Only Bob should see this event" }],
      });

      // Bob receives it
      const bobMsg = yield* bob.client.waitForEvent("messages/received");
      expect(bobMsg).toBeDefined();

      // Alice should NOT have received an event — drain her buffer and verify
      const aliceEvents = alice.client
        .drainEvents()
        .filter((e) => e.event === "messages/received");
      expect(aliceEvents).toHaveLength(0);

      yield* alice.client.close();
      yield* bob.client.close();
    }),
  );
});
