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
import { it } from "@effect/vitest";
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
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
  registerAgent,
  getKyselyDb,
  type ServerTestClient,
} from "../helpers.js";

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

describe("#463 v3 — messages/send preflightRecipients", () => {
  it.live(
    "preflight fail-closed: recipient offline → RpcFailure(HookBlocked) AND no messages row inserted",
    () =>
      Effect.gen(function* () {
        const agents = yield* setupThreeAgents(1);
        const { conversationId } = yield* setupGroupConversation(agents);

        // Knock out the recipient's WS. Sender + TM remain live; the
        // preflight should still fail because the recipient has zero
        // live connections in the AgentEndpointResolver.
        yield* agents.recipient.close();
        // Brief grace period for the WS finalizer to drain the resolver.
        yield* Effect.sleep("200 millis");

        const outcome = yield* Effect.either(
          agents.sender.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "should be rejected" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          // The preflight error maps to HookBlocked via the existing
          // `deliveryErrorToHookBlocked` helper, so the wire surface is
          // identical to the pre-#463 post-INSERT failure mode.
          expect(err.code).toBe(HookBlockedError.code);
        }

        // The load-bearing assertion: NO `messages` row exists for the
        // conversation. Pre-#463 v3 the row would have committed and
        // the TM-routing branch would have surfaced the same RPC error
        // post-INSERT; v3 pulls the check pre-INSERT so the durable
        // state is clean.
        const db = getKyselyDb();
        const rows = yield* Effect.promise(() =>
          db
            .selectFrom("messages")
            .select("id")
            .where("conversation_id", "=", conversationId)
            .execute(),
        );
        expect(rows).toHaveLength(0);
      }),
    20_000,
  );

  it.live(
    "preflight pass: all recipients online → row committed AND broadcast delivers AND messages/list returns the row",
    () =>
      // Companion happy path. With every non-sender participant live,
      // the preflight passes, the row commits, and the broadcast fan-out
      // reaches the recipient. `messages/list` on the durable row is the
      // recovery channel architect plan §9 R1 points to for the
      // post-preflight WriteFailed residual; pinning that view here lets
      // the failure-mode test above stay focused on the no-row outcome.
      //
      // Memory `feedback_predicate_tautology_lesson`: count + id match
      // is the load-bearing assertion — a regression that silently
      // no-ops the INSERT trips the count, and a regression that
      // inserts a stale id trips the id-match.
      Effect.gen(function* () {
        const agents = yield* setupThreeAgents(2);
        const { conversationId } = yield* setupGroupConversation(agents);

        const sent = yield* agents.sender.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "happy path" }],
        });
        expect(sent.message.parts).toEqual([
          { type: "text", text: "happy path" },
        ]);

        // Recipient observes the message via the conversation broadcast.
        const received = yield* agents.recipient.waitForNotification(
          MessageReceivedNotificationDefinition,
        );
        const receivedMsg = (received.params as { message: Message }).message;
        expect(receivedMsg.id).toBe(sent.message.id);

        // Row exists (preflight passed AND sendInsert committed).
        const db = getKyselyDb();
        const rows = yield* Effect.promise(() =>
          db
            .selectFrom("messages")
            .select("id")
            .where("conversation_id", "=", conversationId)
            .execute(),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(sent.message.id);

        // Pull-recovery channel (architect plan §9 R1 mitigation):
        // `messages/list` returns the durable row. Any participant who
        // missed the live notification (TOCTOU residual) sees the
        // message via this list call.
        const listed = yield* agents.sender.sendRpc(MessagesList, {
          conversationId,
        });
        const idsInList = listed.messages.map((m) => m.id);
        expect(idsInList).toContain(sent.message.id);
      }),
    20_000,
  );
});
