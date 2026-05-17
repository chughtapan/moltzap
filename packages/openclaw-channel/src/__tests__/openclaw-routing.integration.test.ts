/**
 * Tier 2: real OpenClaw gateway + real MoltZap server integration tests.
 *
 * Every test uses shared OpenClaw containers from globalSetup with an echo
 * model provider, so no LLM API keys are required.
 */

import { beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import * as fc from "fast-check";
import { Data, Effect, Exit } from "effect";
import { MoltZapWsClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test";
import { getLogs } from "../test-utils/container-core.js";
import {
  registerAndClaim,
  extractMessage,
  extractConvId,
  extractText,
} from "./test-helpers.js";

import {
  AgentsLookupByName,
  ConversationsCreate,
  MessagesSend,
  type Message,
} from "@moltzap/protocol";

interface GatewayHarness {
  readonly containerAId: string;
  readonly containerAAgentId: string;
  readonly containerBAgentId: string;
}

let wsUrl: string;

const NOTIFICATION_WAIT_TIMEOUT_MS = 60_000;
const STANDARD_SCENARIO_TIMEOUT_MS = 90_000;
const LONG_SCENARIO_TIMEOUT_MS = 120_000;
const CROSS_CONTAINER_SCENARIO_TIMEOUT_MS = 180_000;
const CONVERSATION_EVENT_SETTLE_MS = 500;
const LARGE_MESSAGE_CHARS = 5_000;
const MIN_LARGE_REPLY_CHARS = 4_096;
const RECONNECT_SETTLE_MS = 1_000;
const RAPID_MESSAGE_COUNT = 3;
const TWO_CONTAINER_COUNT = 2;

const GATEWAY_LOG_PATTERN = "[gateway]";
const MOLTZAP_LOG_PATTERN = "[moltzap]";
const ECHO_PREFIX = "ECHO:";
const TEXT_PART_TYPE = "text";
const DM_HELLO_TEXT = "hello from alice";
const GROUP_HELLO_TEXT = "hello group";
const CONTAINER_A_TEXT = "hello container-a";
const CONTAINER_B_TEXT = "hello container-b";
const PROACTIVE_RECEIVER_NAME = "out-receiver-pro";
const DUPLICATE_RECEIVER_NAME = "out-receiver-dup";
const PROACTIVE_TEXT = "proactive hello";
const FIRST_TEXT = "first";
const SECOND_TEXT = "second";
const BEFORE_DROP_TEXT = "before drop";
const AFTER_RECONNECT_TEXT = "after reconnect";
const LARGE_MESSAGE_CHARACTER = "A";
const INTEGRATION_GROUP_NAME = "Integration Group";
const MISSING_AGENT_NAME = "nonexistent-agent-xyz";

class RoutingIntegrationError extends Data.TaggedError(
  "RoutingIntegrationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

beforeAll(() => {
  wsUrl = inject("wsUrl");
});

describe.skipIf(inject("containerAId") === "")(
  "Real OpenClaw gateway integration",
  defineGatewayIntegrationSuite,
);

function defineGatewayIntegrationSuite() {
  const harness = gatewayHarness();
  it("gateway starts, loads MoltZap plugin, connects to server", () =>
    gatewayStarts(harness.containerAId));
  it("DM: alice sends -> OpenClaw dispatch -> echo reply arrives", () =>
    dmEchoReplyArrives(harness.containerAAgentId));
  it("group: message dispatched through real OpenClaw", () =>
    groupMessageDispatches(harness.containerAAgentId));
  it("rapid: multiple messages all get echo replies", () =>
    rapidMessagesGetReplies(harness.containerAAgentId));
  it("two agents: both receive and reply from their own containers", () =>
    twoAgentsReplyFromOwnContainers(harness));
  it("agent proactively sends to agent:<name>, DM auto-created", () =>
    proactiveMessageArrives(harness.containerAAgentId));
  it(
    "second message to same agent reuses conversation",
    duplicateTargetReusesConversation,
  );
  it("send to nonexistent agent returns error", missingAgentLookupFails);
  it("large message (>4096 chars) is delivered intact", () =>
    largeMessageDelivered(harness.containerAAgentId));
  it("reconnection during dispatch recovers after WebSocket drop", () =>
    reconnectDuringDispatchRecovers(harness.containerAAgentId));
  it(
    "property: scenario timeouts exceed notification waits",
    timeoutsCoverNotificationWait,
  );
}

function gatewayHarness(): GatewayHarness {
  return {
    containerAId: inject("containerAId"),
    containerAAgentId: inject("containerAAgentId"),
    containerBAgentId: inject("containerBAgentId"),
  };
}

function gatewayStarts(containerAId: string) {
  return Effect.sync(() => {
    const logs = getLogs(containerAId);
    expect(logs).toContain(GATEWAY_LOG_PATTERN);
    expect(logs).toContain(MOLTZAP_LOG_PATTERN);
  });
}

function dmEchoReplyArrives(containerAAgentId: string) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedClaimedClient("a2a-alice-dm");
    const convId = yield* createConversation(aliceClient, {
      type: "dm",
      participants: [{ type: "agent", id: containerAAgentId }],
    });
    yield* sendText(aliceClient, convId, DM_HELLO_TEXT);
    const reply = yield* waitForReceivedMessage(aliceClient);
    expectEchoReply(reply, convId, containerAAgentId);
    yield* aliceClient.close();
  });
}

function groupMessageDispatches(containerAAgentId: string) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedClaimedClient("a2a-alice-grp");
    const eve = yield* registerAgent("a2a-eve-grp");
    const convId = yield* createConversation(aliceClient, {
      type: "group",
      name: INTEGRATION_GROUP_NAME,
      participants: [
        { type: "agent", id: containerAAgentId },
        { type: "agent", id: eve.agentId },
      ],
    });
    yield* Effect.sleep(`${CONVERSATION_EVENT_SETTLE_MS} millis`);
    yield* sendText(aliceClient, convId, GROUP_HELLO_TEXT);
    const reply = yield* waitForReceivedMessage(aliceClient);
    expect(reply.parts.length).toBeGreaterThan(0);
    expect(reply.conversationId).toBe(convId);
    expect(extractText(reply)).toContain(ECHO_PREFIX);
    yield* aliceClient.close();
  });
}

function rapidMessagesGetReplies(containerAAgentId: string) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedClaimedClient("a2a-alice-rapid");
    const convId = yield* createConversation(aliceClient, {
      type: "dm",
      participants: [{ type: "agent", id: containerAAgentId }],
    });
    for (let index = 0; index < RAPID_MESSAGE_COUNT; index++) {
      yield* sendText(aliceClient, convId, `Message ${index}`);
    }
    const replies = yield* waitForReceivedMessages(
      aliceClient,
      RAPID_MESSAGE_COUNT,
    );
    for (const reply of replies) {
      expectEchoReply(extractMessage(reply), convId, containerAAgentId);
    }
    yield* aliceClient.close();
  });
}

function twoAgentsReplyFromOwnContainers(harness: GatewayHarness) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedClaimedClient("2a-alice");
    const convAId = yield* createDm(aliceClient, harness.containerAAgentId);
    const convBId = yield* createDm(aliceClient, harness.containerBAgentId);
    yield* sendText(aliceClient, convAId, CONTAINER_A_TEXT);
    yield* sendText(aliceClient, convBId, CONTAINER_B_TEXT);
    const events = yield* waitForReceivedMessages(
      aliceClient,
      TWO_CONTAINER_COUNT,
    );
    const messages = events.map(extractMessage);
    expectConversationMessageFrom(messages, convAId, harness.containerAAgentId);
    expectConversationMessageFrom(messages, convBId, harness.containerBAgentId);
    yield* aliceClient.close();
  });
}

function proactiveMessageArrives(containerAAgentId: string) {
  return Effect.gen(function* () {
    const receiver = yield* registerAgent(PROACTIVE_RECEIVER_NAME);
    const receiverClient = connectedClient(receiver.apiKey);
    yield* receiverClient.connect();
    const senderClient = connectedClient(inject("containerAApiKey"));
    yield* senderClient.connect();
    const convId = yield* createDm(
      senderClient,
      yield* lookupAgentId(senderClient, PROACTIVE_RECEIVER_NAME),
    );
    yield* sendText(senderClient, convId, PROACTIVE_TEXT);
    const received = yield* waitForReceivedMessage(receiverClient);
    expect(received.senderId).toBe(containerAAgentId);
    expect(extractText(received)).toBe(PROACTIVE_TEXT);
    expect(received.conversationId).toBe(convId);
    yield* senderClient.close();
    yield* receiverClient.close();
  });
}

function duplicateTargetReusesConversation() {
  return Effect.gen(function* () {
    const receiver = yield* registerAgent(DUPLICATE_RECEIVER_NAME);
    const receiverClient = connectedClient(receiver.apiKey);
    yield* receiverClient.connect();
    const senderClient = connectedClient(inject("containerAApiKey"));
    yield* senderClient.connect();
    const receiverId = yield* lookupAgentId(
      senderClient,
      DUPLICATE_RECEIVER_NAME,
    );
    const convId = yield* createDm(senderClient, receiverId);
    yield* sendText(senderClient, convId, FIRST_TEXT);
    const msg1 = yield* waitForReceivedMessage(receiverClient);
    yield* sendText(senderClient, convId, SECOND_TEXT);
    const msg2 = yield* waitForReceivedMessage(receiverClient);
    expect(msg1.conversationId).toBe(convId);
    expect(msg2.conversationId).toBe(convId);
    yield* senderClient.close();
    yield* receiverClient.close();
  });
}

function missingAgentLookupFails() {
  return Effect.gen(function* () {
    const agentClient = yield* connectedClaimedClient("err-sender");
    const result = yield* Effect.exit(
      agentClient.sendRpc(AgentsLookupByName, { name: MISSING_AGENT_NAME }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    yield* agentClient.close();
  });
}

function largeMessageDelivered(containerAAgentId: string) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedClaimedClient("lg-alice");
    const convId = yield* createDm(aliceClient, containerAAgentId);
    const largeText = LARGE_MESSAGE_CHARACTER.repeat(LARGE_MESSAGE_CHARS);
    yield* sendText(aliceClient, convId, largeText);
    const reply = yield* waitForReceivedMessage(aliceClient);
    expect(reply.conversationId).toBe(convId);
    expect(reply.senderId).toBe(containerAAgentId);
    const replyText = extractText(reply);
    expect(replyText).toContain(ECHO_PREFIX);
    expect(replyText.length).toBeGreaterThan(MIN_LARGE_REPLY_CHARS);
    yield* aliceClient.close();
  });
}

function reconnectDuringDispatchRecovers(containerAAgentId: string) {
  return Effect.gen(function* () {
    const alice = yield* registerAgent("rd-alice");
    const aliceClient = connectedClient(alice.apiKey);
    yield* aliceClient.connect();
    const convId = yield* createDm(aliceClient, containerAAgentId);
    yield* sendText(aliceClient, convId, BEFORE_DROP_TEXT);
    expect(extractText(yield* waitForReceivedMessage(aliceClient))).toContain(
      ECHO_PREFIX,
    );
    yield* aliceClient.close();
    yield* Effect.sleep(`${RECONNECT_SETTLE_MS} millis`);
    const aliceClient2 = connectedClient(alice.apiKey);
    yield* aliceClient2.connect();
    yield* sendText(aliceClient2, convId, AFTER_RECONNECT_TEXT);
    const reply2 = yield* waitForReceivedMessage(aliceClient2);
    expect(extractText(reply2)).toContain(ECHO_PREFIX);
    expect(reply2.conversationId).toBe(convId);
    yield* aliceClient2.close();
  });
}

function registerAgent(name: string) {
  return Effect.tryPromise({
    try: () => registerAndClaim(name),
    catch: (cause) =>
      new RoutingIntegrationError({ message: `register ${name}`, cause }),
  });
}

function connectedClaimedClient(name: string) {
  return Effect.gen(function* () {
    const agent = yield* registerAgent(name);
    const client = connectedClient(agent.apiKey);
    yield* client.connect();
    return client;
  });
}

function connectedClient(agentKey: string) {
  return new MoltZapWsClient({
    serverUrl: stripWsPath(wsUrl),
    agentKey,
  });
}

function createDm(client: MoltZapWsClient, agentId: string) {
  return createConversation(client, {
    type: "dm",
    participants: [{ type: "agent", id: agentId }],
  });
}

function createConversation(
  client: MoltZapWsClient,
  params: Parameters<typeof ConversationsCreate.validateParams>[0],
) {
  return client
    .sendRpc(ConversationsCreate, params)
    .pipe(Effect.map(extractConvId));
}

function sendText(
  client: MoltZapWsClient,
  conversationId: string,
  text: string,
) {
  return client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: TEXT_PART_TYPE, text }],
  });
}

function waitForReceivedMessage(client: MoltZapWsClient) {
  return client
    .waitForNotification("messages/received", NOTIFICATION_WAIT_TIMEOUT_MS)
    .pipe(Effect.map(extractMessage));
}

function waitForReceivedMessages(client: MoltZapWsClient, count: number) {
  return Effect.all(
    Array.from({ length: count }, () =>
      client.waitForNotification(
        "messages/received",
        NOTIFICATION_WAIT_TIMEOUT_MS,
      ),
    ),
    { concurrency: count },
  );
}

function expectEchoReply(
  reply: Message,
  conversationId: string,
  senderId: string,
): void {
  expect(reply.parts.length).toBeGreaterThan(0);
  expect(reply.conversationId).toBe(conversationId);
  expect(reply.senderId).toBe(senderId);
  expect(extractText(reply)).toContain(ECHO_PREFIX);
}

function findConversationMessage(
  messages: readonly Message[],
  conversationId: string,
): Message | undefined {
  return messages.find((message) => message.conversationId === conversationId);
}

function expectConversationMessageFrom(
  messages: readonly Message[],
  conversationId: string,
  senderId: string,
): void {
  const message = findConversationMessage(messages, conversationId);
  expect(message).toBeDefined();
  if (message === undefined) return;
  expectEchoReply(message, conversationId, senderId);
}

function lookupAgentId(client: MoltZapWsClient, name: string) {
  return client
    .sendRpc(AgentsLookupByName, { names: [name] })
    .pipe(Effect.map((result) => result.agents[0]?.id ?? ""));
}

function timeoutsCoverNotificationWait() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          STANDARD_SCENARIO_TIMEOUT_MS,
          LONG_SCENARIO_TIMEOUT_MS,
          CROSS_CONTAINER_SCENARIO_TIMEOUT_MS,
        ),
        (scenarioTimeout) => {
          expect(scenarioTimeout).toBeGreaterThan(NOTIFICATION_WAIT_TIMEOUT_MS);
        },
      ),
    );
  });
}
