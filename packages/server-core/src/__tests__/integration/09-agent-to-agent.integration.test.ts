import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
} from "./helpers.js";

let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  const server = await startTestServer();
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
});

describe("Scenario 1: Full Agent-to-Agent DM Flow", () => {
  it("both agents connect first, then create DM and exchange messages", async () => {
    const alice = await registerAndConnect("alice-a2a");
    const bob = await registerAndConnect("bob-a2a");

    // Alice creates DM — server subscribes Bob's already-open connection
    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string; type: string } };
    expect(conv.conversation.type).toBe("dm");
    const conversationId = conv.conversation.id;

    // Set up waiter before send
    const bobEventPromise = bob.client.waitForEvent("messages/received");
    await alice.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Hello Bob!" }],
    });
    const bobEvent = await bobEventPromise;
    expect(
      (bobEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Hello Bob!");

    const aliceEventPromise = alice.client.waitForEvent("messages/received");
    await bob.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Hey Alice!" }],
    });
    const aliceEvent = await aliceEventPromise;
    expect(
      (aliceEvent.data as { message: { parts: Array<{ text: string }> } })
        .message.parts[0]!.text,
    ).toBe("Hey Alice!");

    // Both list messages
    const msgs = (await alice.client.rpc("messages/list", {
      conversationId,
    })) as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0]!.parts[0]!.text).toBe("Hello Bob!");
    expect(msgs.messages[1]!.parts[0]!.text).toBe("Hey Alice!");

    alice.client.close();
    bob.client.close();
  });
});

describe("Scenario 5: Group Chat Fan-Out", () => {
  it("messages fan out to all group participants", async () => {
    const alice = await registerAndConnect("alice-fan");
    const bob = await registerAndConnect("bob-fan");
    const eve = await registerAndConnect("eve-fan");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "group",
      name: "Team Chat",
      participants: [
        { type: "agent", id: bob.agentId },
        { type: "agent", id: eve.agentId },
      ],
    })) as { conversation: { id: string } };
    const conversationId = conv.conversation.id;

    // Set up waiters before send
    const bobStandupPromise = bob.client.waitForEvent("messages/received");
    const eveStandupPromise = eve.client.waitForEvent("messages/received");

    await alice.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "Team standup" }],
    });

    const bobEvent = await bobStandupPromise;
    const eveEvent = await eveStandupPromise;
    expect(
      (bobEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Team standup");
    expect(
      (eveEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Team standup");

    // Set up waiters for Bob's reply
    const aliceReplyPromise = alice.client.waitForEvent("messages/received");
    const eveReplyPromise = eve.client.waitForEvent("messages/received");

    await bob.client.rpc("messages/send", {
      conversationId,
      parts: [{ type: "text", text: "All clear" }],
    });

    const aliceReply = await aliceReplyPromise;
    const eveReply = await eveReplyPromise;
    expect(
      (aliceReply.data as { message: { parts: Array<{ text: string }> } })
        .message.parts[0]!.text,
    ).toBe("All clear");
    expect(
      (eveReply.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("All clear");

    alice.client.close();
    bob.client.close();
    eve.client.close();
  });
});

describe("Regression: conversations/create subscribes connected participants", () => {
  it("participant connected before conversation creation receives messages without reconnecting", async () => {
    const alice = await registerAndConnect("alice-sub");
    const bob = await registerAndConnect("bob-sub");

    // Bob is already connected when Alice creates the DM
    const bobEventPromise = bob.client.waitForEvent("conversations/created");
    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    // Bob should receive the ConversationCreated event
    const createdEvent = await bobEventPromise;
    expect(createdEvent).toBeDefined();

    // Bob should also receive messages WITHOUT reconnecting
    const bobMsgPromise = bob.client.waitForEvent("messages/received");
    await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "No reconnect needed" }],
    });
    const msgEvent = await bobMsgPromise;
    expect(
      (msgEvent.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("No reconnect needed");

    alice.client.close();
    bob.client.close();
  });
});

describe("Regression: waitForEvent does not double-consume buffered events", () => {
  it("sequential waitForEvent calls return distinct events, not duplicates", async () => {
    const alice = await registerAndConnect("alice-buf");
    const bob = await registerAndConnect("bob-buf");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    // Set up waiter for first message
    const msg1Promise = bob.client.waitForEvent("messages/received");
    await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "First" }],
    });
    const msg1 = await msg1Promise;
    expect(
      (msg1.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("First");

    // Set up waiter for second message — must NOT return "First" again
    const msg2Promise = bob.client.waitForEvent("messages/received");
    await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Second" }],
    });
    const msg2 = await msg2Promise;
    expect(
      (msg2.data as { message: { parts: Array<{ text: string }> } }).message
        .parts[0]!.text,
    ).toBe("Second");

    alice.client.close();
    bob.client.close();
  });
});

describe("Regression: messages/send excludes sender from broadcast", () => {
  it("sender does not receive their own message as an event", async () => {
    const alice = await registerAndConnect("alice-noecho");
    const bob = await registerAndConnect("bob-noecho");

    const conv = (await alice.client.rpc("conversations/create", {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    })) as { conversation: { id: string } };

    // Bob waits for the message
    const bobMsgPromise = bob.client.waitForEvent("messages/received");

    // Alice sends
    await alice.client.rpc("messages/send", {
      conversationId: conv.conversation.id,
      parts: [{ type: "text", text: "Only Bob should see this event" }],
    });

    // Bob receives it
    const bobMsg = await bobMsgPromise;
    expect(bobMsg).toBeDefined();

    // Alice should NOT have received an event — drain her buffer and verify
    const aliceEvents = alice.client
      .drainEvents()
      .filter((e) => e.event === "messages/received");
    expect(aliceEvents).toHaveLength(0);

    alice.client.close();
    bob.client.close();
  });
});
