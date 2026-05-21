/**
 * Regression coverage for offline conversation participants.
 *
 * `messages/send` is durable first and participant fan-out is best-effort:
 * an offline non-sender participant must not block insertion. The task manager
 * path remains fail-closed in `task-manager-routing.test.ts`; this file covers
 * the separate participant-broadcast path.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import {
  DEFAULT_APP_ID,
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
  TaskAddParticipant,
  TaskConversationCreate,
  TaskCreate,
  type ConversationId,
  type Message,
  type TaskId,
} from "@moltzap/protocol";
import {
  awaitOneNotification,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  registerAgent,
  getKyselyDb,
  type ServerTestClient,
} from "../helpers.js";

const it = effectIt.live;
const OFFLINE_TEXT = "sent while recipient offline";
const HAPPY_TEXT = "happy path";
const FINALIZER_GRACE = "200 millis";
const TEST_TIMEOUT_MS = 20_000;

let baseUrl: string;
let wsUrl: string;

beforeAll(
  () =>
    Effect.runPromise(
      startTestServerEffect().pipe(
        Effect.tap((server) =>
          Effect.sync(() => {
            baseUrl = server.baseUrl;
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
  readonly tm: ServerTestClient;
  readonly tmAgentId: string;
  readonly sender: ServerTestClient;
  readonly senderAgentId: string;
  readonly recipient: ServerTestClient;
  readonly recipientAgentId: string;
  readonly recipientApiKey: string;
}

function setupThreeAgents(index: number): Effect.Effect<ThreeAgents, Error> {
  return Effect.gen(function* () {
    const tmReg = yield* registerAgent(baseUrl, `offline-tm-${index}`);
    const senderReg = yield* registerAgent(baseUrl, `offline-sender-${index}`);
    const recipientReg = yield* registerAgent(
      baseUrl,
      `offline-recipient-${index}`,
    );
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

function connectTracked(agentId: string, apiKey: string) {
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
    const task = yield* agents.tm.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    yield* agents.tm.sendRpc(TaskAddParticipant, {
      taskId: task.task.id,
      agentId: agents.senderAgentId,
    });
    yield* agents.tm.sendRpc(TaskAddParticipant, {
      taskId: task.task.id,
      agentId: agents.recipientAgentId,
    });
    const conv = yield* agents.tm.sendRpc(TaskConversationCreate, {
      taskId: task.task.id,
      participants: [agents.senderAgentId, agents.recipientAgentId],
    });
    return { taskId: task.task.id, conversationId: conv.conversation.id };
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
  client: ServerTestClient,
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
    const sent = yield* sendText(agents.sender, binding, HAPPY_TEXT);
    expect(sent.message.parts).toEqual([{ type: "text", text: HAPPY_TEXT }]);

    const received = yield* awaitOneNotification(
      agents.recipient,
      MessageReceivedNotificationDefinition,
    );
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
