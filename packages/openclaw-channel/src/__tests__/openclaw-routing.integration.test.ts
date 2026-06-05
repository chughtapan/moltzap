/**
 * Tier 2: real OpenClaw gateway + real MoltZap server integration tests.
 *
 * Every test uses shared OpenClaw containers from globalSetup with an echo
 * model provider, so no LLM API keys are required.
 */

import { beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import * as fc from "fast-check";
import { Data, Duration, Effect, Fiber, Option, Stream } from "effect";
import { MoltZapAgentClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test-utils";
import { getLogs } from "../test-utils/container-core.js";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import {
  registerTestAgent,
  extractMessage,
  extractTaskBinding,
  extractText,
  type TaskBinding,
} from "./test-helpers.js";

import { AgentsLookupByName } from "@moltzap/protocol/identity";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import {
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "@moltzap/protocol/message";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AgentKey } from "@moltzap/protocol/credentials";
import type { Message } from "@moltzap/protocol/message";

interface GatewayHarness {
  readonly containerAId: string;
  readonly containerAAgentId: AgentId;
  readonly containerBAgentId: AgentId;
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
    containerAAgentId: agentId(inject("containerAAgentId")),
    containerBAgentId: agentId(inject("containerBAgentId")),
  };
}

function gatewayStarts(containerAId: string) {
  return Effect.sync(() => {
    const logs = getLogs(containerAId);
    expect(logs).toContain(GATEWAY_LOG_PATTERN);
    expect(logs).toContain(MOLTZAP_LOG_PATTERN);
  });
}

function dmEchoReplyArrives(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedRegisteredClient("a2a-alice-dm");
    const binding = yield* createDm(aliceClient, containerAAgentId);
    // Fork the response-listener BEFORE the trigger send. Stream-based
    // subscribe has no historical buffer; the echo reply can arrive in
    // the gap between `sendText` returning and the listener registering,
    // so the listener must be in place first.
    const replyFiber = yield* Effect.fork(waitForReceivedMessage(aliceClient));
    yield* sendText(aliceClient, binding, DM_HELLO_TEXT);
    const reply = yield* Fiber.join(replyFiber);
    expectEchoReply(reply, binding.conversationId, containerAAgentId);
    yield* aliceClient.close();
  });
}

function groupMessageDispatches(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedRegisteredClient("a2a-alice-grp");
    const eve = yield* registerAgent("a2a-eve-grp");
    const binding = yield* createGroup(aliceClient, INTEGRATION_GROUP_NAME, [
      containerAAgentId,
      eve.agentId,
    ]);
    yield* Effect.sleep(`${CONVERSATION_EVENT_SETTLE_MS} millis`);
    // Fork-before-trigger: listener must be in place before sendText,
    // since Stream subscribe has no historical buffer.
    const replyFiber = yield* Effect.fork(waitForReceivedMessage(aliceClient));
    yield* sendText(aliceClient, binding, GROUP_HELLO_TEXT);
    const reply = yield* Fiber.join(replyFiber);
    expect(reply.parts.length).toBeGreaterThan(0);
    expect(reply.conversationId).toBe(binding.conversationId);
    expect(extractText(reply)).toContain(ECHO_PREFIX);
    yield* aliceClient.close();
  });
}

function rapidMessagesGetReplies(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedRegisteredClient("a2a-alice-rapid");
    const binding = yield* createDm(aliceClient, containerAAgentId);
    // Fork-before-trigger: subscribe for N replies before emitting any
    // sends, so no echo can arrive in the gap between the final send and
    // the listener registering.
    const repliesFiber = yield* Effect.fork(
      waitForReceivedMessages(aliceClient, RAPID_MESSAGE_COUNT),
    );
    for (let index = 0; index < RAPID_MESSAGE_COUNT; index++) {
      yield* sendText(aliceClient, binding, `Message ${index}`);
    }
    const replies = yield* Fiber.join(repliesFiber);
    for (const reply of replies) {
      expectEchoReply(
        extractMessage(reply),
        binding.conversationId,
        containerAAgentId,
      );
    }
    yield* aliceClient.close();
  });
}

function twoAgentsReplyFromOwnContainers(harness: GatewayHarness) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedRegisteredClient("2a-alice");
    const bindingA = yield* createDm(aliceClient, harness.containerAAgentId);
    const bindingB = yield* createDm(aliceClient, harness.containerBAgentId);
    // Fork-before-trigger: the wait for the 2 echo replies is registered
    // before any send.
    const eventsFiber = yield* Effect.fork(
      waitForReceivedMessages(aliceClient, TWO_CONTAINER_COUNT),
    );
    yield* sendText(aliceClient, bindingA, CONTAINER_A_TEXT);
    yield* sendText(aliceClient, bindingB, CONTAINER_B_TEXT);
    const events = yield* Fiber.join(eventsFiber);
    const messages = events.map(extractMessage);
    expectConversationMessageFrom(
      messages,
      bindingA.conversationId,
      harness.containerAAgentId,
    );
    expectConversationMessageFrom(
      messages,
      bindingB.conversationId,
      harness.containerBAgentId,
    );
    yield* aliceClient.close();
  });
}

function proactiveMessageArrives(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const receiver = yield* registerAgent(PROACTIVE_RECEIVER_NAME);
    const receiverClient = connectedClient(receiver.apiKey);
    yield* receiverClient.connect();
    const senderClient = connectedClient(
      redactedAgentKey(inject("containerAApiKey")),
    );
    yield* senderClient.connect();
    const binding = yield* createDm(
      senderClient,
      yield* lookupAgentId(senderClient, PROACTIVE_RECEIVER_NAME),
    );
    // Fork-before-trigger.
    const receivedFiber = yield* Effect.fork(
      waitForReceivedMessage(receiverClient),
    );
    yield* sendText(senderClient, binding, PROACTIVE_TEXT);
    const received = yield* Fiber.join(receivedFiber);
    expect(received.senderId).toBe(containerAAgentId);
    expect(extractText(received)).toBe(PROACTIVE_TEXT);
    expect(received.conversationId).toBe(binding.conversationId);
    yield* senderClient.close();
    yield* receiverClient.close();
  });
}

function duplicateTargetReusesConversation() {
  return Effect.gen(function* () {
    const receiver = yield* registerAgent(DUPLICATE_RECEIVER_NAME);
    const receiverClient = connectedClient(receiver.apiKey);
    yield* receiverClient.connect();
    const senderClient = connectedClient(
      redactedAgentKey(inject("containerAApiKey")),
    );
    yield* senderClient.connect();
    const receiverId = yield* lookupAgentId(
      senderClient,
      DUPLICATE_RECEIVER_NAME,
    );
    const binding = yield* createDm(senderClient, receiverId);
    // Fork-before-trigger per message.
    const msg1Fiber = yield* Effect.fork(
      waitForReceivedMessage(receiverClient),
    );
    yield* sendText(senderClient, binding, FIRST_TEXT);
    const msg1 = yield* Fiber.join(msg1Fiber);
    const msg2Fiber = yield* Effect.fork(
      waitForReceivedMessage(receiverClient),
    );
    yield* sendText(senderClient, binding, SECOND_TEXT);
    const msg2 = yield* Fiber.join(msg2Fiber);
    expect(msg1.conversationId).toBe(binding.conversationId);
    expect(msg2.conversationId).toBe(binding.conversationId);
    yield* senderClient.close();
    yield* receiverClient.close();
  });
}

function missingAgentLookupFails() {
  return Effect.gen(function* () {
    const agentClient = yield* connectedRegisteredClient("err-sender");
    const result = yield* agentClient.call(AgentsLookupByName.name, {
      names: [MISSING_AGENT_NAME],
    });
    expect(result.agents).toEqual([]);
    yield* agentClient.close();
  });
}

function largeMessageDelivered(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const aliceClient = yield* connectedRegisteredClient("lg-alice");
    const binding = yield* createDm(aliceClient, containerAAgentId);
    const largeText = LARGE_MESSAGE_CHARACTER.repeat(LARGE_MESSAGE_CHARS);
    // Fork-before-trigger.
    const replyFiber = yield* Effect.fork(waitForReceivedMessage(aliceClient));
    yield* sendText(aliceClient, binding, largeText);
    const reply = yield* Fiber.join(replyFiber);
    expect(reply.conversationId).toBe(binding.conversationId);
    expect(reply.senderId).toBe(containerAAgentId);
    const replyText = extractText(reply);
    expect(replyText).toContain(ECHO_PREFIX);
    expect(replyText.length).toBeGreaterThan(MIN_LARGE_REPLY_CHARS);
    yield* aliceClient.close();
  });
}

function reconnectDuringDispatchRecovers(containerAAgentId: AgentId) {
  return Effect.gen(function* () {
    const alice = yield* registerAgent("rd-alice");
    const aliceClient = connectedClient(alice.apiKey);
    yield* aliceClient.connect();
    const binding = yield* createDm(aliceClient, containerAAgentId);
    // Fork-before-trigger for each leg.
    const replyFiber1 = yield* Effect.fork(waitForReceivedMessage(aliceClient));
    yield* sendText(aliceClient, binding, BEFORE_DROP_TEXT);
    expect(extractText(yield* Fiber.join(replyFiber1))).toContain(ECHO_PREFIX);
    yield* aliceClient.close();
    yield* Effect.sleep(`${RECONNECT_SETTLE_MS} millis`);
    const aliceClient2 = connectedClient(alice.apiKey);
    yield* aliceClient2.connect();
    const replyFiber2 = yield* Effect.fork(
      waitForReceivedMessage(aliceClient2),
    );
    yield* sendText(aliceClient2, binding, AFTER_RECONNECT_TEXT);
    const reply2 = yield* Fiber.join(replyFiber2);
    expect(extractText(reply2)).toContain(ECHO_PREFIX);
    expect(reply2.conversationId).toBe(binding.conversationId);
    yield* aliceClient2.close();
  });
}

function registerAgent(name: string) {
  return Effect.tryPromise({
    try: () => registerTestAgent(name),
    catch: (cause) =>
      new RoutingIntegrationError({ message: `register ${name}`, cause }),
  });
}

function connectedRegisteredClient(name: string) {
  return Effect.gen(function* () {
    const agent = yield* registerAgent(name);
    const client = connectedClient(agent.apiKey);
    yield* client.connect();
    return client;
  });
}

function connectedClient(agentKey: AgentKey) {
  return new MoltZapAgentClient({
    serverUrl: stripWsPath(wsUrl),
    agentKey,
  });
}

function createDm(
  client: MoltZapAgentClient,
  invitee: AgentId,
): Effect.Effect<TaskBinding, unknown> {
  return client
    .call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [invitee],
      initialConversation: { participants: [invitee] },
    })
    .pipe(Effect.map(extractTaskBinding));
}

function createGroup(
  client: MoltZapAgentClient,
  name: string,
  agentIds: ReadonlyArray<AgentId>,
): Effect.Effect<TaskBinding, unknown> {
  return client
    .call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: agentIds,
      initialConversation: { name, participants: agentIds },
    })
    .pipe(Effect.map(extractTaskBinding));
}

function sendText(
  client: MoltZapAgentClient,
  binding: TaskBinding,
  text: string,
) {
  return client.call(MessagesSend.name, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: TEXT_PART_TYPE, text }],
  });
}

/**
 * Wait for one `messages/received` notification: consume the typed
 * `subscribe(def)` Stream with `Stream.runHead` under a timeout, then
 * project the decoded payload with `extractMessage`.
 */
function waitForReceivedMessage(client: MoltZapAgentClient) {
  return client.subscribe(MessageReceivedNotificationDefinition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(NOTIFICATION_WAIT_TIMEOUT_MS),
      onTimeout: () =>
        new RoutingIntegrationError({
          message: "timed out waiting for messages/received notification",
        }),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new RoutingIntegrationError({
              message:
                "messages/received Stream completed before a frame arrived",
            }),
          ),
        onSome: (frame) => Effect.succeed(extractMessage(frame)),
      }),
    ),
  );
}

function waitForReceivedMessages(client: MoltZapAgentClient, count: number) {
  return client.subscribe(MessageReceivedNotificationDefinition).pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.timeoutFail({
      duration: Duration.millis(NOTIFICATION_WAIT_TIMEOUT_MS),
      onTimeout: () =>
        new RoutingIntegrationError({
          message: `timed out waiting for ${count} messages/received notifications`,
        }),
    }),
    Effect.map((chunk) => Array.from(chunk)),
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

function lookupAgentId(client: MoltZapAgentClient, name: string) {
  return client.call(AgentsLookupByName.name, { names: [name] }).pipe(
    Effect.flatMap((result) => {
      const found = result.agents[0]?.id;
      return found === undefined
        ? Effect.fail(
            new RoutingIntegrationError({
              message: `agent not found: ${name}`,
            }),
          )
        : Effect.succeed(found);
    }),
  );
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
