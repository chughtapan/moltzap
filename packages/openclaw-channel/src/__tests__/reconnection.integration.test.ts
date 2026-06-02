import { beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import * as fc from "fast-check";
import { Data, Effect, Stream } from "effect";
import { MoltZapAgentClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test";
import type {
  AgentId,
  ConversationId,
  Message,
  TaskId,
} from "@moltzap/protocol";
import { registerAndClaim, waitFor } from "./test-helpers.js";

import {
  AgentsLookup,
  DEFAULT_APP_ID,
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
  TaskRequest,
} from "@moltzap/protocol";

let baseUrl: string;
let wsUrl: string;

const DISCONNECT_WAIT_MS = 3_000;
const RECONNECT_WAIT_MS = 10_000;
const MESSAGE_DELIVERY_WAIT_MS = 5_000;
const WAIT_BUDGET_FACTOR_MIN = 1;
const WAIT_BUDGET_FACTOR_MAX = 3;

const RECONNECT_BOB_NAME = "recon-bob";
const RECONNECT_ALICE_HISTORY_NAME = "recon-alice-history";
const RECONNECT_BOB_HISTORY_NAME = "recon-bob-history";
const RECONNECT_ALICE_EVENT_NAME = "recon-alice-evt";
const RECONNECT_BOB_EVENT_NAME = "recon-bob-evt";
const RECONNECT_BOB_CLOSE_NAME = "recon-bob-close";
const RECONNECT_BOB_RPC_NAME = "recon-bob-rpc";
const BEFORE_DISCONNECT_TEXT = "Before disconnect";
const AFTER_RECONNECT_TEXT = "After reconnect";
const MISSED_WHILE_OFFLINE_TEXT = "Missed while offline";
const TEXT_PART_TYPE = "text";
const SINGLE_AGENT_COUNT = 1;

class ReconnectionTestError extends Data.TaggedError("ReconnectionTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

beforeAll(() => {
  baseUrl = inject("baseUrl");
  wsUrl = inject("wsUrl");
});

describe("Flow 8: Reconnection + missed message catch-up", () => {
  it(
    "reconnects after disconnect with exponential backoff",
    reconnectsAfterDisconnect,
  );
  it(
    "onReconnect receives HelloOk and missed messages are readable from history",
    onReconnectReceivesHelloOk,
  );
  it("events received after reconnect are dispatched", eventsAfterReconnect);
  it("close() prevents reconnection", closePreventsReconnection);
  it("RPC calls work after reconnection", rpcCallsWorkAfterReconnect);
  it("property: reconnect waits dominate disconnect waits", waitBudgetsOrdered);
});

function registerAgent(name: string) {
  return Effect.tryPromise({
    try: () => registerAndClaim(name),
    catch: (cause) =>
      new ReconnectionTestError({
        message: `Registration failed for ${name}`,
        cause,
      }),
  });
}

function waitUntil(predicate: () => boolean, timeoutMs: number, label: string) {
  return Effect.tryPromise({
    try: () => waitFor(predicate, timeoutMs),
    catch: (cause) =>
      new ReconnectionTestError({
        message: `Timed out waiting for ${label}`,
        cause,
      }),
  });
}

function createClient(agentKey: string, options = {}) {
  return new MoltZapAgentClient({
    serverUrl: baseUrl,
    agentKey,
    ...options,
  });
}

function createStrippedClient(agentKey: string) {
  return new MoltZapAgentClient({
    serverUrl: stripWsPath(wsUrl),
    agentKey,
  });
}

interface DmBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

function createDmConversation(
  client: MoltZapAgentClient,
  invitee: AgentId,
): Effect.Effect<DmBinding, unknown> {
  return client
    .call(TaskRequest.name, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [invitee],
      initialConversation: { participants: [invitee] },
    })
    .pipe(
      Effect.map((result) => ({
        taskId: result.task.id,
        conversationId: result.conversation!.id,
      })),
    );
}

function sendText(
  client: MoltZapAgentClient,
  binding: DmBinding,
  text: string,
) {
  return client.call(MessagesSend.name, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: TEXT_PART_TYPE, text }],
  });
}

function listMessageTexts(client: MoltZapAgentClient, binding: DmBinding) {
  return client
    .call(MessagesList.name, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    })
    .pipe(Effect.map((result) => messageTexts(result.messages)));
}

function messageTexts(messages: readonly Message[]): readonly string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === TEXT_PART_TYPE ? [part.text] : [],
    ),
  );
}

function expectFirstMessageText(messages: readonly Message[], text: string) {
  expect(messages[0]?.parts[0]).toEqual({
    type: TEXT_PART_TYPE,
    text,
  });
}

function reconnectsAfterDisconnect() {
  return Effect.gen(function* () {
    const bob = yield* registerAgent(RECONNECT_BOB_NAME);
    let disconnected = false;
    let reconnected = false;
    const client = createClient(bob.apiKey, {
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnected = true;
      },
    });

    yield* client.connect();
    yield* client.disconnect();
    yield* waitUntil(() => disconnected, DISCONNECT_WAIT_MS, "disconnect");
    expect(disconnected).toBe(true);
    yield* waitUntil(() => reconnected, RECONNECT_WAIT_MS, "reconnect");
    expect(reconnected).toBe(true);
    yield* client.close();
  });
}

function onReconnectReceivesHelloOk() {
  return Effect.gen(function* () {
    const alice = yield* registerAgent(RECONNECT_ALICE_HISTORY_NAME);
    const bob = yield* registerAgent(RECONNECT_BOB_HISTORY_NAME);
    const aliceClient = createStrippedClient(alice.apiKey);
    yield* aliceClient.connect();
    const binding = yield* createDmConversation(aliceClient, bob.agentId);
    let reconnectHelloOk: unknown = null;
    const bobClient = createClient(bob.apiKey, {
      onDisconnect: () => undefined,
      onReconnect: (helloOk: unknown) => {
        reconnectHelloOk = helloOk;
      },
    });

    yield* bobClient.connect();
    yield* bobClient.disconnect();
    yield* sendText(aliceClient, binding, MISSED_WHILE_OFFLINE_TEXT);
    yield* waitUntil(
      () => reconnectHelloOk !== null,
      RECONNECT_WAIT_MS,
      "missed-message reconnect",
    );
    expect(reconnectHelloOk).toMatchObject({ agentId: bob.agentId });
    expect(yield* listMessageTexts(bobClient, binding)).toContain(
      MISSED_WHILE_OFFLINE_TEXT,
    );
    yield* bobClient.close();
    yield* aliceClient.close();
  });
}

function eventsAfterReconnect() {
  return Effect.gen(function* () {
    const alice = yield* registerAgent(RECONNECT_ALICE_EVENT_NAME);
    const bob = yield* registerAgent(RECONNECT_BOB_EVENT_NAME);
    const receivedMessages: Message[] = [];
    let disconnected = false;
    let reconnected = false;
    const bobClient = createClient(bob.apiKey, {
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnected = true;
      },
    });
    // Spec B (#596): `subscribe({}, handler)` is gone; use the
    // `subscribeAll` Stream and fork a `runForEach` consumer so the
    // listener is live BEFORE `bobClient.connect()` opens the socket
    // (subscribe-before-trigger). Fork the daemon — `bobClient.close()`
    // at the end of the test terminates the Stream via the registry's
    // `closeAll` path, which lets the daemon exit cleanly.
    yield* Effect.forkDaemon(
      bobClient
        .subscribeAll()
        .pipe(Stream.runForEach(captureMessages(receivedMessages))),
    );
    yield* bobClient.connect();
    const aliceClient = createStrippedClient(alice.apiKey);
    yield* aliceClient.connect();
    const binding = yield* createDmConversation(aliceClient, bob.agentId);

    yield* sendText(aliceClient, binding, BEFORE_DISCONNECT_TEXT);
    yield* waitForReceivedMessages(receivedMessages);
    expectFirstMessageText(receivedMessages, BEFORE_DISCONNECT_TEXT);
    yield* bobClient.disconnect();
    yield* waitUntil(() => disconnected, DISCONNECT_WAIT_MS, "disconnect");
    yield* waitUntil(() => reconnected, RECONNECT_WAIT_MS, "reconnect");
    receivedMessages.length = 0;
    yield* sendText(aliceClient, binding, AFTER_RECONNECT_TEXT);
    yield* waitForReceivedMessages(receivedMessages);
    expectFirstMessageText(receivedMessages, AFTER_RECONNECT_TEXT);
    yield* bobClient.close();
    yield* aliceClient.close();
  });
}

function captureMessages(receivedMessages: Message[]) {
  return (event: { readonly definition: unknown; readonly params: unknown }) =>
    Effect.sync(() => {
      if (event.definition === MessageReceivedNotificationDefinition) {
        const params = event.params as { readonly message?: Message };
        const message = params.message;
        if (message !== undefined) receivedMessages.push(message);
      }
    });
}

function waitForReceivedMessages(receivedMessages: readonly Message[]) {
  return waitUntil(
    () => receivedMessages.length >= SINGLE_AGENT_COUNT,
    MESSAGE_DELIVERY_WAIT_MS,
    "message delivery",
  );
}

function closePreventsReconnection() {
  return Effect.gen(function* () {
    const bob = yield* registerAgent(RECONNECT_BOB_CLOSE_NAME);
    let reconnectCount = 0;
    let disconnected = false;
    const client = createClient(bob.apiKey, {
      onDisconnect: () => {
        disconnected = true;
      },
      onReconnect: () => {
        reconnectCount++;
      },
    });

    yield* client.connect();
    yield* client.close();
    yield* waitUntil(() => disconnected, DISCONNECT_WAIT_MS, "close");
    yield* Effect.sleep(`${DISCONNECT_WAIT_MS} millis`);
    expect(reconnectCount).toBe(0);
  });
}

function rpcCallsWorkAfterReconnect() {
  return Effect.gen(function* () {
    const bob = yield* registerAgent(RECONNECT_BOB_RPC_NAME);
    let reconnected = false;
    const client = createClient(bob.apiKey, {
      onDisconnect: () => undefined,
      onReconnect: () => {
        reconnected = true;
      },
    });

    yield* client.connect();
    yield* client.disconnect();
    yield* waitUntil(() => reconnected, RECONNECT_WAIT_MS, "reconnect");
    const result = yield* client.call(AgentsLookup.name, {
      agentIds: [bob.agentId],
    });

    expect(result.agents).toHaveLength(SINGLE_AGENT_COUNT);
    expect(result.agents[0]?.name).toBe(RECONNECT_BOB_RPC_NAME);
    yield* client.close();
  });
}

function waitBudgetsOrdered() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.integer({
          min: WAIT_BUDGET_FACTOR_MIN,
          max: WAIT_BUDGET_FACTOR_MAX,
        }),
        (factor) => {
          expect(RECONNECT_WAIT_MS).toBeGreaterThan(
            DISCONNECT_WAIT_MS * factor,
          );
        },
      ),
    );
  });
}
