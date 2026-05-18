/**
 * #463 v3 — end-to-end coverage for the pre-INSERT recipient preflight
 * in `messages/send`.
 *
 * Architect plan §1: `MessageService.preflightRecipients` runs BEFORE
 * the durable {@link MessageService.sendInsert} INSERT. When any
 * non-sender participant has zero live connections the preflight fails
 * closed with {@link RecipientNotResolved}; the handler maps it to
 * `RpcFailure(HookBlocked)` and the row is never written. This is the
 * load-bearing observable for the AC: a `messages` row never appears
 * for a send that the broadcast loop is provably unable to fan out.
 *
 * Companion unit test:
 * `packages/server/src/task/services/message.service.test.ts`
 * (resolver-empty branch pinned at the service boundary, no WS).
 *
 * Memory `feedback_predicate_tautology_lesson`: the post-failure DB
 * assertion targets `count(*) = 0` against `messages` for the
 * conversation under test — the predicate fails on accidental
 * INSERT, not on a vacuous "no error thrown" tautology. The happy-path
 * companion pins `count(*) = 1` and matches the inserted id, so the
 * test cannot pass on a regression that silently no-ops the INSERT.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it as effectIt } from "@effect/vitest";

import { Effect, Either } from "effect";
import {
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  MessagesList,
  MessagesSend,
  TasksAddParticipant,
  TasksCreate,
  TasksCreateConversation,
  type Message,
} from "@moltzap/protocol";
import { agentId as protocolAgentId } from "@moltzap/protocol/testing";
import {
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
const REJECTED_TEXT = "should be rejected";
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
}

/**
 * Register three agents (TM + sender + recipient). The TM is the
 * task-manager for the conversation; sender and recipient are both
 * participants in the conversation alongside the TM.
 */
function setupThreeAgents(index: number): Effect.Effect<ThreeAgents, Error> {
  return Effect.gen(function* () {
    const tmReg = yield* registerAgent(baseUrl, `pre-tm-${index}`);
    const senderReg = yield* registerAgent(baseUrl, `pre-sender-${index}`);
    const recipientReg = yield* registerAgent(
      baseUrl,
      `pre-recipient-${index}`,
    );
    const tm = yield* connectTestClient({
      wsUrl,
      agentId: tmReg.agentId,
      apiKey: tmReg.apiKey,
    });
    trackClient(tm);
    const sender = yield* connectTestClient({
      wsUrl,
      agentId: senderReg.agentId,
      apiKey: senderReg.apiKey,
    });
    trackClient(sender);
    const recipient = yield* connectTestClient({
      wsUrl,
      agentId: recipientReg.agentId,
      apiKey: recipientReg.apiKey,
    });
    trackClient(recipient);
    return {
      tm,
      tmAgentId: tmReg.agentId,
      sender,
      senderAgentId: senderReg.agentId,
      recipient,
      recipientAgentId: recipientReg.agentId,
    };
  });
}

interface GroupBinding {
  readonly conversationId: string;
}

/**
 * Stand up a task-bound group conversation with sender + recipient as
 * participants. The TM is the conversation creator (and so is a
 * participant by default); sender and recipient are added explicitly so
 * the resolver-miss test can knock out the recipient's socket without
 * also dropping the TM.
 */
function setupGroupConversation(
  agents: ThreeAgents,
): Effect.Effect<GroupBinding, Error> {
  return Effect.gen(function* () {
    const task = yield* agents.tm.sendRpc(TasksCreate, { tmType: "self" });
    yield* agents.tm.sendRpc(TasksAddParticipant, {
      taskId: task.task.id,
      agentId: protocolAgentId(agents.senderAgentId),
    });
    yield* agents.tm.sendRpc(TasksAddParticipant, {
      taskId: task.task.id,
      agentId: protocolAgentId(agents.recipientAgentId),
    });
    const conv = yield* agents.tm.sendRpc(TasksCreateConversation, {
      taskId: task.task.id,
      type: "group",
      participants: [
        { type: "agent", id: agents.senderAgentId },
        { type: "agent", id: agents.recipientAgentId },
      ],
    });
    return { conversationId: conv.conversation.id };
  });
}

function messageRowsForConversation(conversationId: string) {
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

function expectHookBlocked(outcome: Either.Either<unknown, unknown>): void {
  Either.match(outcome, {
    onLeft: (error) => {
      const err = error as { code?: number };
      expect(err.code).toBe(HookBlockedError.code);
    },
    onRight: () => expect.fail("expected HookBlockedError"),
  });
}

function rejectsOfflineRecipientBeforeInsert() {
  return Effect.gen(function* () {
    const agents = yield* setupThreeAgents(1);
    const { conversationId } = yield* setupGroupConversation(agents);

    yield* agents.recipient.close();
    yield* Effect.sleep(FINALIZER_GRACE);

    const outcome = yield* Effect.either(
      agents.sender.sendRpc(MessagesSend, {
        conversationId,
        parts: [{ type: "text", text: REJECTED_TEXT }],
      }),
    );
    expectHookBlocked(outcome);
    expect(yield* messageRowsForConversation(conversationId)).toHaveLength(0);
  });
}

function commitsAndBroadcastsWhenRecipientsOnline() {
  return Effect.gen(function* () {
    const agents = yield* setupThreeAgents(2);
    const { conversationId } = yield* setupGroupConversation(agents);
    const sent = yield* agents.sender.sendRpc(MessagesSend, {
      conversationId,
      parts: [{ type: "text", text: HAPPY_TEXT }],
    });
    expect(sent.message.parts).toEqual([{ type: "text", text: HAPPY_TEXT }]);

    const received = yield* agents.recipient.waitForNotification(
      MessageReceivedNotificationDefinition,
    );
    const receivedMsg = (received.params as { message: Message }).message;
    expect(receivedMsg.id).toBe(sent.message.id);

    const rows = yield* messageRowsForConversation(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(sent.message.id);

    const listed = yield* agents.sender.sendRpc(MessagesList, {
      conversationId,
    });
    expect(listed.messages.map((message) => message.id)).toContain(
      sent.message.id,
    );
  });
}

describe("#463 v3 — messages/send preflightRecipients", () => {
  it(
    "preflight fail-closed: recipient offline → RpcFailure(HookBlocked) AND no messages row inserted",
    rejectsOfflineRecipientBeforeInsert,
    TEST_TIMEOUT_MS,
  );

  it(
    "preflight pass: all recipients online → row committed AND broadcast delivers AND messages/list returns the row",
    // Companion happy path. With every non-sender participant live,
    // the preflight passes, the row commits, and the broadcast fan-out
    // reaches the recipient. `messages/list` on the durable row is the
    // recovery channel architect plan §9 R1 points to for the
    // post-preflight WriteFailed residual; pinning that view here lets
    // the failure-mode test above stay focused on the no-row outcome.
    commitsAndBroadcastsWhenRecipientsOnline,
    TEST_TIMEOUT_MS,
  );
});
