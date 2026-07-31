import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  awaitOneNotification,
  firstTextPart,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  type ConnectedAgent,
} from "../helpers.js";
import { DEFAULT_APP_ID } from "@moltzap/protocol/identity";
import {
  messageReceivedNotificationDefinition,
  messagesList,
  messagesSend,
} from "@moltzap/protocol/message";
import {
  agentConversationCreate,
  conversationCreatedNotificationDefinition,
  type ConversationId,
} from "@moltzap/protocol/conversation";

const it = effectIt.live;

const GROUP_NAME = "Team Chat";
const HELLO_BOB = "Hello Bob!";
const HEY_ALICE = "Hey Alice!";
const TEAM_STANDUP = "Team standup";
const ALL_CLEAR = "All clear";
const NO_RECONNECT_NEEDED = "No reconnect needed";
const FIRST_MESSAGE = "First";
const SECOND_MESSAGE = "Second";
const NO_ECHO_MESSAGE = "Only Bob should see this event";

beforeAll(() => Effect.runPromise(startTestServerEffect()));
afterAll(() => Effect.runPromise(stopTestServerEffect()));
beforeEach(() => Effect.runPromise(resetTestDbEffect()));

function textPart(text: string) {
  return { type: "text" as const, text };
}

function createDm(
  creator: ConnectedAgent,
  participant: ConnectedAgent,
): Effect.Effect<ConversationId, unknown> {
  return creator.client
    .sendRpc(agentConversationCreate, {
      appId: DEFAULT_APP_ID,
      participants: [participant.agentId],
    })
    .pipe(Effect.map((result) => result.conversation.id));
}

function createGroup(
  creator: ConnectedAgent,
  participants: readonly ConnectedAgent[],
): Effect.Effect<ConversationId, unknown> {
  return creator.client
    .sendRpc(agentConversationCreate, {
      appId: DEFAULT_APP_ID,
      name: GROUP_NAME,
      participants: participants.map((p) => p.agentId),
    })
    .pipe(Effect.map((result) => result.conversation.id));
}

function sendText(
  sender: ConnectedAgent,
  conversationId: ConversationId,
  text: string,
) {
  return sender.client.sendRpc(messagesSend, {
    conversationId,
    parts: [textPart(text)],
  });
}

function notificationText(notification: { params: unknown }): string {
  const parts =
    /* Safe because the test fixture establishes this asserted shape. */
    (notification.params as { message: { parts: Array<{ text: string }> } })
      .message.parts;
  const firstPart = parts[0];
  if (firstPart === undefined) {
    throw new Error("Expected a notification text part.");
  }
  return firstPart.text;
}

function waitForMessageText(agent: ConnectedAgent) {
  return awaitOneNotification(
    agent.client,
    messageReceivedNotificationDefinition,
  ).pipe(Effect.map(notificationText));
}

function messageTextsFor(
  agent: ConnectedAgent,
  conversationId: ConversationId,
) {
  return agent.client
    .sendRpc(messagesList, { conversationId })
    .pipe(
      Effect.map((result) =>
        result.messages.map((message) => firstTextPart(message.parts)),
      ),
    );
}

const NO_ECHO_SETTLE_MS = 500;

function closeAgents(agents: readonly ConnectedAgent[]) {
  return Effect.all(
    agents.map((agent) => agent.client.close()),
    { concurrency: 1 },
  );
}

function fullDmFlow() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-a2a");
    const bob = yield* registerAndConnect("bob-a2a");

    const conversationId = yield* createDm(alice, bob);

    const bobHello = yield* Effect.fork(waitForMessageText(bob));
    yield* sendText(alice, conversationId, HELLO_BOB);
    expect(yield* Fiber.join(bobHello)).toBe(HELLO_BOB);

    const aliceReply = yield* Effect.fork(waitForMessageText(alice));
    yield* sendText(bob, conversationId, HEY_ALICE);
    expect(yield* Fiber.join(aliceReply)).toBe(HEY_ALICE);

    expect(yield* messageTextsFor(alice, conversationId)).toEqual([
      HELLO_BOB,
      HEY_ALICE,
    ]);
    yield* closeAgents([alice, bob]);
  });
}

function groupChatFansOut() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-fan");
    const bob = yield* registerAndConnect("bob-fan");
    const eve = yield* registerAndConnect("eve-fan");
    const conversationId = yield* createGroup(alice, [bob, eve]);

    const bobStandup = yield* Effect.fork(waitForMessageText(bob));
    const eveStandup = yield* Effect.fork(waitForMessageText(eve));
    yield* sendText(alice, conversationId, TEAM_STANDUP);
    expect(yield* Fiber.join(bobStandup)).toBe(TEAM_STANDUP);
    expect(yield* Fiber.join(eveStandup)).toBe(TEAM_STANDUP);

    const aliceAllClear = yield* Effect.fork(waitForMessageText(alice));
    const eveAllClear = yield* Effect.fork(waitForMessageText(eve));
    yield* sendText(bob, conversationId, ALL_CLEAR);
    expect(yield* Fiber.join(aliceAllClear)).toBe(ALL_CLEAR);
    expect(yield* Fiber.join(eveAllClear)).toBe(ALL_CLEAR);
    yield* closeAgents([alice, bob, eve]);
  });
}

function connectedParticipantReceivesWithoutReconnect() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-sub");
    const bob = yield* registerAndConnect("bob-sub");
    const createdEventFiber = yield* Effect.fork(
      awaitOneNotification(
        bob.client,
        conversationCreatedNotificationDefinition,
      ),
    );
    const conversationId = yield* createDm(alice, bob);

    const createdEvent = yield* Fiber.join(createdEventFiber);
    expect(createdEvent).toBeDefined();

    const bobMessage = yield* Effect.fork(waitForMessageText(bob));
    yield* sendText(alice, conversationId, NO_RECONNECT_NEEDED);
    expect(yield* Fiber.join(bobMessage)).toBe(NO_RECONNECT_NEEDED);
    yield* closeAgents([alice, bob]);
  });
}

function liveSubscriptionDeliversSequentialEvents() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-buf");
    const bob = yield* registerAndConnect("bob-buf");
    const conversationId = yield* createDm(alice, bob);

    const messages = yield* bob.client
      .subscribe(messageReceivedNotificationDefinition)
      .pipe(
        Stream.take(2),
        Stream.map((params) => firstTextPart(params.message.parts)),
        Stream.runCollect,
        Effect.map(Chunk.toReadonlyArray),
        Effect.fork,
      );
    yield* sendText(alice, conversationId, FIRST_MESSAGE);
    yield* sendText(alice, conversationId, SECOND_MESSAGE);
    expect(yield* Fiber.join(messages)).toEqual([
      FIRST_MESSAGE,
      SECOND_MESSAGE,
    ]);
    yield* closeAgents([alice, bob]);
  });
}

function senderDoesNotReceiveOwnMessage() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-noecho");
    const bob = yield* registerAndConnect("bob-noecho");
    const conversationId = yield* createDm(alice, bob);

    // Subscribe Alice before the send so the stream observes any echo frame
    // that arrives in flight. `Stream.interruptAfter` bounds the collection
    // window.
    const aliceEcho = yield* alice.client
      .subscribe(messageReceivedNotificationDefinition)
      .pipe(
        Stream.interruptAfter(Duration.millis(NO_ECHO_SETTLE_MS)),
        Stream.runCollect,
        Effect.fork,
      );

    const bobEvent = yield* Effect.fork(
      awaitOneNotification(bob.client, messageReceivedNotificationDefinition),
    );

    yield* sendText(alice, conversationId, NO_ECHO_MESSAGE);
    expect(yield* Fiber.join(bobEvent)).toBeDefined();
    const echoEvents = Chunk.toReadonlyArray(yield* Fiber.join(aliceEcho));
    expect(echoEvents).toHaveLength(0);
    yield* closeAgents([alice, bob]);
  });
}

describe("Scenario 1: Full Agent-to-Agent DM Flow", () => {
  it(
    "both agents connect first, then create DM and exchange messages",
    fullDmFlow,
  );
});

describe("Scenario 5: Group Chat Fan-Out", () => {
  it("messages fan out to all group participants", groupChatFansOut);
});

describe("Regression: app/conversation/create subscribes connected participants", () => {
  it(
    "participant connected before conversation creation receives messages without reconnecting",
    connectedParticipantReceivesWithoutReconnect,
  );
});

describe("Regression: subscribe Stream delivers sequential live events", () => {
  it(
    "a single subscription returns distinct events, not duplicates",
    liveSubscriptionDeliversSequentialEvents,
  );
});

describe("Regression: agent/message/send excludes sender from broadcast", () => {
  it(
    "sender does not receive their own message as an event",
    senderDoesNotReceiveOwnMessage,
  );
});
