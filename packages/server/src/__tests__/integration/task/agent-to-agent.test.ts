import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import {
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  registerAndConnect,
  type ConnectedAgent,
} from "../helpers.js";
import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
} from "@moltzap/protocol";

const it = effectIt.live;

const CONV_TYPE_DM = "dm";
const CONV_TYPE_GROUP = "group";
const PARTICIPANT_TYPE_AGENT = "agent";
const PART_TYPE_TEXT = "text";
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

function agentParticipant(agent: ConnectedAgent) {
  return { type: PARTICIPANT_TYPE_AGENT, id: agent.agentId };
}

function textPart(text: string) {
  return { type: PART_TYPE_TEXT, text };
}

function createDm(creator: ConnectedAgent, participant: ConnectedAgent) {
  return creator.client.sendRpc(ConversationsCreate, {
    type: CONV_TYPE_DM,
    participants: [agentParticipant(participant)],
  }) as Effect.Effect<{ conversation: { id: string; type: string } }, unknown>;
}

function createGroup(
  creator: ConnectedAgent,
  participants: ReadonlyArray<ConnectedAgent>,
) {
  return creator.client.sendRpc(ConversationsCreate, {
    type: CONV_TYPE_GROUP,
    name: GROUP_NAME,
    participants: participants.map(agentParticipant),
  }) as Effect.Effect<{ conversation: { id: string } }, unknown>;
}

function sendText(
  sender: ConnectedAgent,
  conversationId: string,
  text: string,
) {
  return sender.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [textPart(text)],
  });
}

function notificationText(notification: { params: unknown }): string {
  return (
    notification.params as { message: { parts: Array<{ text: string }> } }
  ).message.parts[0]!.text;
}

function waitForMessageText(agent: ConnectedAgent) {
  return agent.client
    .waitForNotification(MessageReceivedNotificationDefinition)
    .pipe(Effect.map(notificationText));
}

function messageTextsFor(agent: ConnectedAgent, conversationId: string) {
  return agent.client.sendRpc(MessagesList, { conversationId }).pipe(
    Effect.map(
      (result) =>
        (result as { messages: Array<{ parts: Array<{ text: string }> }> })
          .messages,
    ),
    Effect.map((messages) => messages.map((message) => message.parts[0]!.text)),
  );
}

function isMessageReceivedEvent(event: {
  readonly definition?: unknown;
}): boolean {
  return event.definition === MessageReceivedNotificationDefinition;
}

function drainMessageReceivedEvents(agent: ConnectedAgent) {
  return agent.client.drainNotifications().filter(isMessageReceivedEvent);
}

function closeAgents(agents: ReadonlyArray<ConnectedAgent>) {
  return Effect.all(
    agents.map((agent) => agent.client.close()),
    { concurrency: 1 },
  );
}

function fullDmFlow() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-a2a");
    const bob = yield* registerAndConnect("bob-a2a");

    const conv = yield* createDm(alice, bob);
    expect(conv.conversation.type).toBe(CONV_TYPE_DM);
    const conversationId = conv.conversation.id;

    yield* sendText(alice, conversationId, HELLO_BOB);
    expect(yield* waitForMessageText(bob)).toBe(HELLO_BOB);

    yield* sendText(bob, conversationId, HEY_ALICE);
    expect(yield* waitForMessageText(alice)).toBe(HEY_ALICE);

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
    const conv = yield* createGroup(alice, [bob, eve]);
    const conversationId = conv.conversation.id;

    yield* sendText(alice, conversationId, TEAM_STANDUP);
    expect(yield* waitForMessageText(bob)).toBe(TEAM_STANDUP);
    expect(yield* waitForMessageText(eve)).toBe(TEAM_STANDUP);

    yield* sendText(bob, conversationId, ALL_CLEAR);
    expect(yield* waitForMessageText(alice)).toBe(ALL_CLEAR);
    expect(yield* waitForMessageText(eve)).toBe(ALL_CLEAR);
    yield* closeAgents([alice, bob, eve]);
  });
}

function connectedParticipantReceivesWithoutReconnect() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-sub");
    const bob = yield* registerAndConnect("bob-sub");
    const conv = yield* createDm(alice, bob);

    const createdEvent = yield* bob.client.waitForNotification(
      ConversationCreatedNotificationDefinition,
    );
    expect(createdEvent).toBeDefined();

    yield* sendText(alice, conv.conversation.id, NO_RECONNECT_NEEDED);
    expect(yield* waitForMessageText(bob)).toBe(NO_RECONNECT_NEEDED);
    yield* closeAgents([alice, bob]);
  });
}

function bufferedNotificationsAreConsumedOnce() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-buf");
    const bob = yield* registerAndConnect("bob-buf");
    const conv = yield* createDm(alice, bob);

    yield* sendText(alice, conv.conversation.id, FIRST_MESSAGE);
    expect(yield* waitForMessageText(bob)).toBe(FIRST_MESSAGE);

    yield* sendText(alice, conv.conversation.id, SECOND_MESSAGE);
    expect(yield* waitForMessageText(bob)).toBe(SECOND_MESSAGE);
    yield* closeAgents([alice, bob]);
  });
}

function senderDoesNotReceiveOwnMessage() {
  return Effect.gen(function* () {
    const alice = yield* registerAndConnect("alice-noecho");
    const bob = yield* registerAndConnect("bob-noecho");
    const conv = yield* createDm(alice, bob);

    yield* sendText(alice, conv.conversation.id, NO_ECHO_MESSAGE);
    expect(
      yield* bob.client.waitForNotification(
        MessageReceivedNotificationDefinition,
      ),
    ).toBeDefined();
    expect(drainMessageReceivedEvents(alice)).toHaveLength(0);
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

describe("Regression: conversations/create subscribes connected participants", () => {
  it(
    "participant connected before conversation creation receives messages without reconnecting",
    connectedParticipantReceivesWithoutReconnect,
  );
});

describe("Regression: waitForNotification does not double-consume buffered events", () => {
  it(
    "sequential waitForNotification calls return distinct events, not duplicates",
    bufferedNotificationsAreConsumedOnce,
  );
});

describe("Regression: messages/send excludes sender from broadcast", () => {
  it(
    "sender does not receive their own message as an event",
    senderDoesNotReceiveOwnMessage,
  );
});
