/**
 * Phase 9b consumer-migration (sub-issue #460, plan §10.1 + §2.4.a +
 * §1.3): end-to-end coverage for `messages/send` → TM routing via
 * `network.send` and the surrounding fail-closed branches.
 *
 * Pre-Phase-9b, `messages/send` invoked `appHost.runBeforeMessageDelivery`
 * for task-bound conversations and surfaced `{ block: true, reason }`
 * verdicts as `RpcFailure(HookBlocked)`. The wire RPC retired in Phase
 * 9b; the gating contract moved to a fire-and-forget `network.send` per
 * §1.3 plus structural pre-checks on the `(task_id, tm_endpoint_address,
 * task.status)` triple.
 *
 * Phase 9b round 3 (R12+R13+R14+R15) reframes the suite:
 *   - R12 made `tasks.tm_endpoint_address` and `conversations.task_id`
 *     NOT NULL — every conversation belongs to a task with a registered
 *     TM. The "task without TM" and "non-task conversation" branches
 *     are unrepresentable in the type system, so the R3 / non-task tests
 *     retire.
 *   - R13 collapsed `tasks/create` + `endpoints/registerTaskManager`
 *     into one atomic call; the deleted `endpoints/*` wire RPCs no
 *     longer appear in the suite.
 *   - R14 added a default-DM / default-group `tm:app:<id>` TM that
 *     `conversations/create` auto-binds; in-process dispatch via
 *     {@link AppTmRegistry} runs on the server's Effect runtime, no
 *     WebSocket round-trip (plan §1.3 in-process loopback policy).
 *
 * Surviving contracts pinned by the suite:
 *  - Custom-TM (werewolf-shaped) routing: TM live → success; TM
 *    offline → `HookBlocked (RecipientNotResolved)`.
 *  - Closed task: `messages/send` fails closed with `TaskClosed`
 *    (codex HIGH-3).
 *  - `tasks/storeMessage` does NOT self-loop the TM (codex HIGH-1).
 *  - Default-DM-TM lifecycle: `conversations/create` auto-mints a
 *    default-TM-bound task; `messages/send` succeeds without any
 *    custom-TM caller registering anything.
 *
 * Setup uses ONLY wire RPCs — `tasks/create`, `tasks/addParticipant`,
 * `tasks/createConversation`, `tasks/storeMessage`, `tasks/close`,
 * `conversations/create` — so the test exercises the same surface
 * arena consumes.
 *
 * Auth-handler transactional behaviour and the close-during-auth race
 * (Phase 9a deferral C2) are covered by the resolver-contract guards in
 * `network/agent-endpoint-resolver.test.ts > Phase 8 codex deferrals`;
 * the wire-level disconnect-drain proof falls out of the "TM offline"
 * test below — it would only pass if the WS finalizer drained the
 * resolver before the next send.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  ConversationsCreate,
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  TaskClosedError,
  TasksAddParticipant,
  TasksClose,
  TasksCreate,
  TasksCreateConversation,
  TasksStoreMessage,
  type Message,
  type Task,
} from "@moltzap/protocol";
import { agentId as protocolAgentId } from "@moltzap/protocol/testing";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
  registerAgent,
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

interface AgentPair {
  readonly tm: ServerTestClient;
  readonly tmAgentId: string;
  readonly sender: ServerTestClient;
  readonly senderAgentId: string;
}

/**
 * Register two agents (TM + sender) and connect both. The TM agent will
 * play the role of the registered task-manager — the recipient of the
 * `network.send`-routed frames. The sender drives `messages/send`.
 *
 * Distinct from the shared `setupAgentPair` helper (which returns
 * `alice / bob`) because the test reads more clearly when the role
 * names match the routing topology: who is the TM, who is the sender.
 */
function setupTmAndSender(index: number): Effect.Effect<AgentPair, Error> {
  return Effect.gen(function* () {
    const tmReg = yield* registerAgent(baseUrl, `tm-${index}`);
    const senderReg = yield* registerAgent(baseUrl, `sender-${index}`);
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
    return {
      tm,
      tmAgentId: tmReg.agentId,
      sender,
      senderAgentId: senderReg.agentId,
    };
  });
}

interface TaskBinding {
  readonly taskId: Task["id"];
  readonly conversationId: string;
}

/**
 * Stand up a task with TM bound atomically and a task-bound conversation
 * containing the sender + TM as participants. Phase 9b round 3 R13: the
 * pre-R13 two-step (`tasks/create` then `endpoints/registerTaskManager`)
 * retired — `tmEndpointAddress` is required at create time.
 */
function setupTaskBoundConversation(
  pair: AgentPair,
): Effect.Effect<TaskBinding, Error> {
  return Effect.gen(function* () {
    // Phase 9b round 4 R16 (codex HIGH-A): the wire body carries
    // `tmType: "self"` — the server resolves the address from the
    // authenticated caller's agent id, rejecting the pre-R16 hole
    // where a caller could pass `tm:agent:<stranger>`.
    const task = yield* pair.tm.sendRpc(TasksCreate, {
      tmType: "self",
    });
    yield* pair.tm.sendRpc(TasksAddParticipant, {
      taskId: task.task.id,
      agentId: protocolAgentId(pair.senderAgentId),
    });
    // DM convention: caller is implicitly one participant; `participants`
    // carries the OTHER (exactly one entry for DMs).
    const conv = yield* pair.tm.sendRpc(TasksCreateConversation, {
      taskId: task.task.id,
      type: "dm",
      participants: [{ type: "agent", id: pair.senderAgentId }],
    });
    return { taskId: task.task.id, conversationId: conv.conversation.id };
  });
}

describe("Phase 9b — messages/send → TM routing via network.send", () => {
  it.live(
    "TM live: messages/send to a task-bound conversation succeeds",
    () =>
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(1);
        const { conversationId } = yield* setupTaskBoundConversation(pair);

        // Sender fires `messages/send`. The server resolves
        //   conversationId → conversations.task_id
        //   task_id → tasks.tm_endpoint_address (`tm:agent:<TM-agentId>`)
        //   resolver.resolveAll(TM-agentId) → ConnectionId set
        //   pick first writable connection → write the frame to the
        //   TM's WS (fire-and-forget per §1.3).
        const sent = yield* pair.sender.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "hi TM" }],
        });
        const message: Message = sent.message;
        expect(message.parts).toEqual([{ type: "text", text: "hi TM" }]);

        // The TM is also a conversation participant (DM type forces
        // the caller of `tasks/createConversation` into the participant
        // set), so it receives the message both via `network.send` (TM
        // routing) and via the conversation broadcast. The contractual
        // proof that `network.send` is the gating mechanism lives in
        // the next two tests; here we only assert the round-trip is
        // healthy end-to-end.
        const received = yield* pair.tm.waitForNotification(
          MessageReceivedNotificationDefinition,
        );
        const receivedMsg = (received.params as { message: Message }).message;
        expect(receivedMsg.id).toBe(message.id);
        expect(receivedMsg.parts).toEqual([{ type: "text", text: "hi TM" }]);
      }),
    20_000,
  );

  it.live(
    "TM offline: messages/send surfaces RpcFailure (RecipientNotResolved → HookBlocked)",
    () =>
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(2);
        const { conversationId } = yield* setupTaskBoundConversation(pair);

        // TM disconnects. The `tm:agent:<TM-agentId>` durable address
        // persists in `tasks.tm_endpoint_address` but the resolver no
        // longer holds any live ConnectionId for the agent. `network.send`
        // returns `RecipientNotResolved`; the message-service maps to
        // `RpcFailure(HookBlocked, ...)`.
        yield* pair.tm.close();
        // Small grace period for the WS finalizer to drain the resolver.
        yield* Effect.sleep("100 millis");

        const outcome = yield* Effect.either(
          pair.sender.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "tm offline" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          expect(err.code).toBe(HookBlockedError.code);
          expect(err.message).toMatch(/Task manager/i);
        }
      }),
    20_000,
  );

  it.live(
    "Closed task: messages/send fails closed with TaskClosed",
    () =>
      // Codex HIGH-3 regression guard. `tasks.close` does not clear
      // `tm_endpoint_address`; the Phase 9b fail-closed branch reads
      // `task.status` and rejects on `closed | failed`.
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(4);
        const { taskId, conversationId } =
          yield* setupTaskBoundConversation(pair);

        // Send once with the task open — should succeed.
        yield* pair.sender.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "before close" }],
        });

        // Close the task. The `tm_endpoint_address` survives but the
        // status becomes `closed`.
        yield* pair.tm.sendRpc(TasksClose, { taskId });

        const outcome = yield* Effect.either(
          pair.sender.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "after close" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as {
            code?: number;
            message?: string;
            data?: { reason?: string; status?: string };
          };
          expect(err.code).toBe(TaskClosedError.code);
          expect(err.data?.reason).toBe("TaskClosed");
          expect(err.data?.status).toBe("closed");
        }
      }),
    20_000,
  );

  it.live(
    "Default-DM-TM: conversations/create auto-binds the default TM; messages/send succeeds without a custom TM",
    () =>
      // Phase 9b round 3 R14 lifecycle pin. Pre-R14, a non-app caller
      // could create a DM via `conversations/create` and the
      // conversation would land with `task_id IS NULL`. R12+R14 made
      // every conversation task-bound; the wire handler mints a
      // default-DM TM (a `tm:app:<deterministic-uuid>` address backed
      // by an in-process `AppTmRegistry` no-op handler). The proof
      // shape: send a message through that conversation and observe
      // it round-trips. Without R14 the send would fail with
      // `RecipientNotResolved` (no live socket holds `tm:app:`).
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(5);
        const conv = yield* pair.sender.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: pair.tmAgentId }],
        });

        const sent = yield* pair.sender.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "hello default TM" }],
        });
        expect(sent.message.parts).toEqual([
          { type: "text", text: "hello default TM" },
        ]);

        // Both participants observe the message via the conversation
        // broadcast — the app-TM in-process handler is a no-op observer,
        // so the surviving delivery path is the conversation fan-out.
        const received = yield* pair.tm.waitForNotification(
          MessageReceivedNotificationDefinition,
        );
        const receivedMsg = (received.params as { message: Message }).message;
        expect(receivedMsg.id).toBe(sent.message.id);
      }),
    20_000,
  );

  it.live(
    "Default-group-TM: conversations/create type=group auto-binds the default group TM",
    () =>
      // Companion to the DM lifecycle test. The DM/group split is
      // preserved as separate `tm:app:<id>` addresses (`R14`) so future
      // differentiation lands without rewiring existing rows. The
      // surviving invariant: a group conversation created without a
      // custom TM accepts messages.
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(7);
        const conv = yield* pair.sender.sendRpc(ConversationsCreate, {
          type: "group",
          name: "default-group-tm",
          participants: [{ type: "agent", id: pair.tmAgentId }],
        });

        const sent = yield* pair.sender.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "group with default TM" }],
        });
        expect(sent.message.parts).toEqual([
          { type: "text", text: "group with default TM" },
        ]);

        const received = yield* pair.tm.waitForNotification(
          MessageReceivedNotificationDefinition,
        );
        const receivedMsg = (received.params as { message: Message }).message;
        expect(receivedMsg.id).toBe(sent.message.id);
      }),
    20_000,
  );

  it.live(
    "tasks/storeMessage does not self-loop the TM via network.send (codex HIGH-1)",
    () =>
      // The TM authoring a `tasks/storeMessage` call would, without
      // the `bypassTmRouting` flag, re-emit a `messages/received`
      // frame to its own socket via `network.send` — self-loop on
      // every TM-authored insert. The fix passes `bypassTmRouting:
      // true` from `TaskService.storeMessage` to
      // `MessageService.send`. This test pins it: TM stores a
      // message and observes EXACTLY ONE `messages/received` frame
      // (the conversation broadcast), not two.
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(6);
        const { taskId, conversationId } =
          yield* setupTaskBoundConversation(pair);

        // TM stores a message authored by the sender (typical
        // post-admission flow: TM accepted via gate, now persists).
        yield* pair.tm.sendRpc(TasksStoreMessage, {
          taskId,
          conversationId,
          senderAgentId: protocolAgentId(pair.senderAgentId),
          parts: [{ type: "text", text: "stored by TM" }],
        });

        // The TM (a conversation participant) should observe ONE
        // notification via the conversation broadcast. Drain after a
        // brief grace period and count.
        yield* Effect.sleep("200 millis");
        const drained = pair.tm.drainNotifications();
        const receivedCount = drained.filter(
          (n) =>
            n.method === MessageReceivedNotificationDefinition.name &&
            (n.params as { message?: { parts?: unknown[] } }).message?.parts !==
              undefined,
        ).length;
        // With the bypass flag honored, exactly one notification
        // arrives (the conversation broadcast). Without the fix, two
        // would arrive (network.send self-loop + conversation broadcast).
        expect(receivedCount).toBe(1);
      }),
    20_000,
  );
});
