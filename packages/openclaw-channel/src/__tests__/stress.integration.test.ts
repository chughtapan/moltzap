/**
 * Stress integration tests: concurrent multi-agent messaging.
 * Uses shared container from globalSetup, so each test avoids its own startup.
 */

import { beforeAll, describe, expect, inject } from "vitest";
import { live as it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { MoltZapAgentClient } from "@moltzap/client";
import { stripWsPath } from "@moltzap/client/test";
import { getLogs } from "../test-utils/container-core.js";
import {
  registerAndClaim,
  extractConvId,
  extractText,
} from "./test-helpers.js";
import type { Message } from "@moltzap/protocol";

import {
  ConversationsCreate,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol";

interface StressAgent {
  readonly apiKey: string;
}

interface StressClients {
  readonly clientA: MoltZapAgentClient;
  readonly clientB: MoltZapAgentClient;
  readonly clientC: MoltZapAgentClient;
}

interface StressConversationIds {
  readonly convA: string;
  readonly convB: string;
  readonly convC: string;
}

interface StressReplies {
  readonly repliesA: readonly Message[];
  readonly repliesB: readonly Message[];
  readonly repliesC: readonly Message[];
}

let wsUrl: string;

const REPLY_POLL_INTERVAL_MS = 250;
const REPLY_WAIT_TIMEOUT_MS = 90_000;
const STRESS_TEST_TIMEOUT_MS = 180_000;
const MESSAGES_FROM_A = 4;
const MESSAGES_FROM_B = 3;
const MESSAGES_FROM_C = 3;
const TOTAL_STRESS_MESSAGE_COUNT =
  MESSAGES_FROM_A + MESSAGES_FROM_B + MESSAGES_FROM_C;
const STRESS_AGENT_COUNT = 3;
const ECHO_PREFIX = "ECHO:";
const AGENT_A_NAME = "stress-a";
const AGENT_B_NAME = "stress-b";
const AGENT_C_NAME = "stress-c";
const TEXT_PART_TYPE = "text";

class StressTestError extends Data.TaggedError("StressTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

beforeAll(() => {
  wsUrl = inject("wsUrl");
});

describe.skipIf(inject("containerAId") === "")(
  "Stress: concurrent multi-agent messaging",
  defineStressSuite,
);

function defineStressSuite() {
  const receiverAgentId = inject("containerAAgentId");
  const containerAId = inject("containerAId");
  it(
    "10 concurrent messages from 3 agents all get echo replies",
    () => runStressScenario(receiverAgentId, containerAId),
    STRESS_TEST_TIMEOUT_MS,
  );
}

function runStressScenario(receiverAgentId: string, containerAId: string) {
  return Effect.gen(function* () {
    const agents = yield* registerStressAgents;
    const clients = yield* stressClients(agents);
    yield* connectStressClients(clients);
    const conversations = yield* createStressConversations(
      clients,
      receiverAgentId,
    );
    yield* sendStressMessages(clients, conversations);
    const replies = yield* waitForStressReplies(
      clients,
      conversations,
      receiverAgentId,
    );
    expectStressReplies(replies, conversations, receiverAgentId);
    yield* closeStressClients(clients);
  }).pipe(Effect.tapError(() => logContainerFailure(containerAId)));
}

const registerStressAgents = Effect.all(
  [
    registerAgent(AGENT_A_NAME),
    registerAgent(AGENT_B_NAME),
    registerAgent(AGENT_C_NAME),
  ],
  { concurrency: STRESS_AGENT_COUNT },
);

function registerAgent(name: string) {
  return Effect.tryPromise({
    try: () => registerAndClaim(name),
    catch: (cause) =>
      new StressTestError({
        message: `Registration failed for ${name}`,
        cause,
      }),
  });
}

function stressClients(
  agents: readonly StressAgent[],
): Effect.Effect<StressClients, StressTestError> {
  const [agentA, agentB, agentC] = agents;
  if (!agentA || !agentB || !agentC) {
    return Effect.fail(
      new StressTestError({
        message: "Stress agent registration returned too few agents",
      }),
    );
  }
  return Effect.succeed({
    clientA: stressClient(agentA.apiKey),
    clientB: stressClient(agentB.apiKey),
    clientC: stressClient(agentC.apiKey),
  });
}

function stressClient(agentKey: string) {
  return new MoltZapAgentClient({
    serverUrl: stripWsPath(wsUrl),
    agentKey,
  });
}

function connectStressClients(clients: StressClients) {
  return Effect.all(
    [
      clients.clientA.connect(),
      clients.clientB.connect(),
      clients.clientC.connect(),
    ],
    { concurrency: STRESS_AGENT_COUNT },
  );
}

function createStressConversations(
  clients: StressClients,
  receiverAgentId: string,
): Effect.Effect<StressConversationIds, unknown> {
  return Effect.all(
    [
      createConversation(clients.clientA, receiverAgentId),
      createConversation(clients.clientB, receiverAgentId),
      createConversation(clients.clientC, receiverAgentId),
    ],
    { concurrency: STRESS_AGENT_COUNT },
  ).pipe(Effect.map(([convA, convB, convC]) => ({ convA, convB, convC })));
}

function createConversation(
  client: MoltZapAgentClient,
  receiverAgentId: string,
) {
  return client
    .sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: receiverAgentId }],
    })
    .pipe(Effect.map(extractConvId));
}

function sendStressMessages(
  clients: StressClients,
  conversations: StressConversationIds,
) {
  return Effect.all(
    [
      ...sendBatch(clients.clientA, conversations.convA, "A", MESSAGES_FROM_A),
      ...sendBatch(clients.clientB, conversations.convB, "B", MESSAGES_FROM_B),
      ...sendBatch(clients.clientC, conversations.convC, "C", MESSAGES_FROM_C),
    ],
    { concurrency: STRESS_AGENT_COUNT },
  );
}

function sendBatch(
  client: MoltZapAgentClient,
  conversationId: string,
  prefix: string,
  count: number,
) {
  return Array.from({ length: count }, (_, i) =>
    client.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: TEXT_PART_TYPE, text: `${prefix}-msg-${i}` }],
    }),
  );
}

function waitForStressReplies(
  clients: StressClients,
  conversations: StressConversationIds,
  receiverAgentId: string,
): Effect.Effect<StressReplies, StressTestError> {
  return Effect.all(
    [
      waitForRepliesByList({
        client: clients.clientA,
        conversationId: conversations.convA,
        receiverAgentId,
        expectedCount: MESSAGES_FROM_A,
        timeoutMs: REPLY_WAIT_TIMEOUT_MS,
      }),
      waitForRepliesByList({
        client: clients.clientB,
        conversationId: conversations.convB,
        receiverAgentId,
        expectedCount: MESSAGES_FROM_B,
        timeoutMs: REPLY_WAIT_TIMEOUT_MS,
      }),
      waitForRepliesByList({
        client: clients.clientC,
        conversationId: conversations.convC,
        receiverAgentId,
        expectedCount: MESSAGES_FROM_C,
        timeoutMs: REPLY_WAIT_TIMEOUT_MS,
      }),
    ],
    { concurrency: STRESS_AGENT_COUNT },
  ).pipe(
    Effect.map(([repliesA, repliesB, repliesC]) => ({
      repliesA,
      repliesB,
      repliesC,
    })),
  );
}

function waitForRepliesByList(params: {
  readonly client: MoltZapAgentClient;
  readonly conversationId: string;
  readonly receiverAgentId: string;
  readonly expectedCount: number;
  readonly timeoutMs: number;
}): Effect.Effect<readonly Message[], StressTestError> {
  return Effect.gen(function* () {
    const deadline = Date.now() + params.timeoutMs;
    while (Date.now() < deadline) {
      const replies = yield* listMatchingReplies(params);
      if (replies.length >= params.expectedCount) {
        return replies.slice(0, params.expectedCount);
      }
      yield* Effect.sleep(`${REPLY_POLL_INTERVAL_MS} millis`);
    }
    return yield* Effect.fail(
      new StressTestError({
        message: `Timed out waiting for replies in ${params.conversationId}`,
      }),
    );
  });
}

function listMatchingReplies(params: {
  readonly client: MoltZapAgentClient;
  readonly conversationId: string;
  readonly receiverAgentId: string;
}) {
  return params.client
    .sendRpc(MessagesList, {
      conversationId: params.conversationId,
      limit: TOTAL_STRESS_MESSAGE_COUNT,
    })
    .pipe(
      Effect.map((result) =>
        result.messages.filter(
          (message) =>
            message.senderId === params.receiverAgentId &&
            extractText(message).includes(ECHO_PREFIX),
        ),
      ),
    );
}

function expectStressReplies(
  replies: StressReplies,
  conversations: StressConversationIds,
  receiverAgentId: string,
) {
  expect(replies.repliesA).toHaveLength(MESSAGES_FROM_A);
  expect(replies.repliesB).toHaveLength(MESSAGES_FROM_B);
  expect(replies.repliesC).toHaveLength(MESSAGES_FROM_C);
  expectReplyBatch(replies.repliesA, conversations.convA, receiverAgentId);
  expectReplyBatch(replies.repliesB, conversations.convB, receiverAgentId);
  expectReplyBatch(replies.repliesC, conversations.convC, receiverAgentId);
  expect(uniqueReplyIds(replies).size).toBe(TOTAL_STRESS_MESSAGE_COUNT);
}

function expectReplyBatch(
  replies: readonly Message[],
  conversationId: string,
  receiverAgentId: string,
) {
  for (const reply of replies) {
    expect(reply.senderId).toBe(receiverAgentId);
    expect(reply.conversationId).toBe(conversationId);
    expect(extractText(reply)).toContain(ECHO_PREFIX);
  }
}

function uniqueReplyIds(replies: StressReplies) {
  return new Set([
    ...replies.repliesA.map((reply) => reply.id),
    ...replies.repliesB.map((reply) => reply.id),
    ...replies.repliesC.map((reply) => reply.id),
  ]);
}

function closeStressClients(clients: StressClients) {
  return Effect.all(
    [clients.clientA.close(), clients.clientB.close(), clients.clientC.close()],
    { concurrency: STRESS_AGENT_COUNT },
  );
}

function logContainerFailure(containerAId: string) {
  return Effect.logError(`Stress container logs:\n${getLogs(containerAId)}`);
}
