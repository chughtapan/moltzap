/**
 * Regression coverage for offline conversation participants.
 *
 * `messages/send` is durable first and participant fan-out is best-effort:
 * an offline non-sender participant must not block insertion.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { DEFAULT_APP_ID, TaskRequest } from "@moltzap/protocol/task";
import {
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
} from "@moltzap/protocol/message";
import type { AgentKey } from "@moltzap/protocol/identity";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import type { TaskId } from "@moltzap/protocol/task";
import {
  awaitOneNotification,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  createTestAgent,
  getKyselyDb,
  type TestAgentClient,
} from "../helpers.js";

const it = effectIt.live;
const OFFLINE_TEXT = "sent while recipient offline";
const HAPPY_TEXT = "happy path";
const FINALIZER_GRACE = "200 millis";
const SUBSCRIBE_SETTLE = "10 millis";
const TEST_TIMEOUT_MS = 20_000;

let wsUrl: string;

beforeAll(
  () =>
    Effect.runPromise(
      startTestServerEffect().pipe(
        Effect.tap((server) =>
          Effect.sync(() => {
            wsUrl = server.wsUrl;
          }),
        ),
      ),
    ),
  60_000,
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

interface ThreeAgents {
  readonly tm: TestAgentClient;
  readonly tmAgentId: AgentId;
  readonly sender: TestAgentClient;
  readonly senderAgentId: AgentId;
  readonly recipient: TestAgentClient;
  readonly recipientAgentId: AgentId;
  readonly recipientApiKey: AgentKey;
}

function setupThreeAgents(index: number): Effect.Effect<ThreeAgents, Error> {
  return Effect.gen(function* () {
    const tmReg = yield* createTestAgent(`offline-tm-${index}`);
    const senderReg = yield* createTestAgent(`offline-sender-${index}`);
    const recipientReg = yield* createTestAgent(`offline-recipient-${index}`);
    const tm = yield* connectTracked(tmReg.agentId, tmReg.apiKey);
    const sender = yield* connectTracked(senderReg.agentId, senderReg.apiKey);
    const recipient = yield* connectTracked(
      recipientReg.agentId,
      recipientReg.apiKey,
    );
    return {
      tm,
      tmAgentId: tmReg.agentId,
      sender,
      senderAgentId: senderReg.agentId,
      recipient,
      recipientAgentId: recipientReg.agentId,
      recipientApiKey: recipientReg.apiKey,
    };
  });
}

function connectTracked(agentId: AgentId, apiKey: AgentKey) {
  return Effect.gen(function* () {
    const client = yield* connectTestClient({ wsUrl, agentId, apiKey });
    trackClient(client);
    return client;
  });
}

interface GroupBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

function setupGroupConversation(
  agents: ThreeAgents,
): Effect.Effect<GroupBinding, unknown> {
  return Effect.gen(function* () {
    // Single TaskRequest auto-admits invitees (#677) + atomically mints
    // the initial conversation. Replaces the prior TaskAddParticipant +
    // TaskConversationCreate dance which is TM-only and unreachable on
    // DEFAULT_APP_ID tasks.
    const created = yield* agents.tm.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [agents.senderAgentId, agents.recipientAgentId],
      initialConversation: {
        participants: [agents.senderAgentId, agents.recipientAgentId],
      },
    });
    return {
      taskId: created.task.id,
      conversationId: created.conversation!.id,
    };
  });
}

function messageRowsForConversation(conversationId: ConversationId) {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .execute(),
    catch: (cause) => cause,
  });
}

function sendText(
  client: TestAgentClient,
  binding: GroupBinding,
  text: string,
) {
  return client.sendRpc(MessagesSend, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
  });
}

function sentMessageTexts(messages: readonly Message[]): readonly string[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

function commitsWhenParticipantIsOffline() {
  return Effect.gen(function* () {
    const agents = yield* setupThreeAgents(1);
    const binding = yield* setupGroupConversation(agents);

    yield* agents.recipient.close();
    yield* Effect.sleep(FINALIZER_GRACE);

    const sent = yield* sendText(agents.sender, binding, OFFLINE_TEXT);
    expect(sent.message.parts).toEqual([{ type: "text", text: OFFLINE_TEXT }]);
    const rows = yield* messageRowsForConversation(binding.conversationId);
    expect(rows.map((row) => row.id)).toContain(sent.message.id);

    const reconnectedRecipient = yield* connectTracked(
      agents.recipientAgentId,
      agents.recipientApiKey,
    );
    const listed = yield* reconnectedRecipient.sendRpc(MessagesList, {
      taskId: binding.taskId,
      conversationId: binding.conversationId,
    });
    expect(sentMessageTexts(listed.messages)).toContain(OFFLINE_TEXT);
  });
}

function broadcastsWhenParticipantsAreOnline() {
  return Effect.gen(function* () {
    const agents = yield* setupThreeAgents(2);
    const binding = yield* setupGroupConversation(agents);
    const receivedFiber = yield* Effect.fork(
      awaitOneNotification(
        agents.recipient,
        MessageReceivedNotificationDefinition,
      ),
    );
    yield* Effect.sleep(SUBSCRIBE_SETTLE);

    const sent = yield* sendText(agents.sender, binding, HAPPY_TEXT);
    expect(sent.message.parts).toEqual([{ type: "text", text: HAPPY_TEXT }]);

    const received = yield* Fiber.join(receivedFiber);
    const receivedMsg = (received.params as { message: Message }).message;
    expect(receivedMsg.id).toBe(sent.message.id);

    const rows = yield* messageRowsForConversation(binding.conversationId);
    expect(rows.map((row) => row.id)).toContain(sent.message.id);
  });
}

describe("messages/send offline participant delivery", () => {
  it(
    "commits the message and lets an offline participant recover it from history",
    commitsWhenParticipantIsOffline,
    TEST_TIMEOUT_MS,
  );

  it(
    "broadcasts to live participants after commit",
    broadcastsWhenParticipantsAreOnline,
    TEST_TIMEOUT_MS,
  );
});
