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
 * task.status)` triple. This test pins the new contract:
 *
 *  - TM live: `messages/send` succeeds; the TM observes the
 *    `MessageReceivedNotification` frame on its WS.
 *  - TM offline: `messages/send` fails with `HookBlocked` (RecipientNotResolved).
 *  - Task without registered TM: `messages/send` fails with `HookBlocked`
 *    (TaskWithoutTm) — closes the silent-fall-through hole codex HIGH-2
 *    flagged.
 *  - Task closed mid-flight: `messages/send` fails with `TaskClosed`
 *    (codex HIGH-3).
 *  - Non-task conversation: `messages/send` falls back to broadcast.
 *  - `tasks/storeMessage` does NOT self-loop (codex HIGH-1): the
 *    TM-authored insert path skips TM routing.
 *
 * Setup uses ONLY wire RPCs — `tasks/create`, `endpoints/registerTaskManager`,
 * `tasks/addParticipant`, `tasks/createConversation`, `tasks/storeMessage`,
 * `tasks/close` — so the test exercises the same surface arena consumes.
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
  EndpointsRegisterTaskManager,
  EndpointsUnregisterTaskManager,
  ErrorCodes,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  TasksAddParticipant,
  TasksClose,
  TasksCreate,
  TasksCreateConversation,
  TasksStoreMessage,
  agentId as protocolAgentId,
  type Message,
  type Task,
} from "@moltzap/protocol";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
  registerAgent,
  type ServerTestClient,
} from "./helpers.js";

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
 * Stand up a task with TM registered and a task-bound conversation
 * containing the sender + TM as participants. The "task without
 * registered TM" failure path is reached at runtime via
 * `endpoints/unregisterTaskManager` after creation — that is the only
 * wire-RPC route to the state because `tasks/createConversation`
 * requires TM authority.
 */
function setupTaskBoundConversation(
  pair: AgentPair,
): Effect.Effect<TaskBinding, Error> {
  return Effect.gen(function* () {
    const task = yield* pair.tm.sendRpc(TasksCreate, {});
    yield* pair.tm.sendRpc(EndpointsRegisterTaskManager, {
      taskId: task.task.id,
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
        // set), so it receives the message both via `network.send` and
        // via Broadcaster. The contractual proof that `network.send`
        // is the gating mechanism lives in the next two tests; here
        // we only assert the round-trip is healthy end-to-end.
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
          expect(err.code).toBe(ErrorCodes.HookBlocked);
          expect(err.message).toMatch(/Task manager/i);
        }
      }),
    20_000,
  );

  it.live(
    "Task without registered TM: messages/send fails closed with HookBlocked (TaskWithoutTm)",
    () =>
      // Codex HIGH-2 regression guard. After the Phase 9b fail-closed
      // branch lands, a task-bound conversation whose initiator
      // unregistered (or never registered) the TM admits zero
      // messages — the broadcast-fallback short-circuit no longer
      // covers it.
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(3);
        const { taskId, conversationId } =
          yield* setupTaskBoundConversation(pair);

        // Unregister TM via the wire RPC. `tasks.tm_endpoint_address`
        // becomes null while the conversation stays bound to the task.
        yield* pair.tm.sendRpc(EndpointsUnregisterTaskManager, { taskId });

        const outcome = yield* Effect.either(
          pair.sender.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "should fail" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as {
            code?: number;
            message?: string;
            data?: { reason?: string };
          };
          expect(err.code).toBe(ErrorCodes.HookBlocked);
          expect(err.message).toMatch(/no registered task manager/i);
          expect(err.data?.reason).toBe("TaskWithoutTm");
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
          expect(err.code).toBe(ErrorCodes.TaskClosed);
          expect(err.data?.reason).toBe("TaskClosed");
          expect(err.data?.status).toBe("closed");
        }
      }),
    20_000,
  );

  it.live(
    "Non-task conversation: messages/send falls back to broadcast",
    () =>
      Effect.gen(function* () {
        const pair = yield* setupTmAndSender(5);
        // No task binding — `conversations.task_id` is null because
        // the conversation is created via `conversations/create`
        // directly, not `tasks/createConversation`.
        const conv = yield* pair.sender.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: pair.tmAgentId }],
        });

        const sent = yield* pair.sender.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "hello no-tm" }],
        });
        expect(sent.message.parts).toEqual([
          { type: "text", text: "hello no-tm" },
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
      // (the broadcaster's), not two.
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
        // notification via Broadcaster. Drain after a brief grace
        // period and count.
        yield* Effect.sleep("200 millis");
        const drained = pair.tm.drainNotifications();
        const receivedCount = drained.filter(
          (n) =>
            n.method === MessageReceivedNotificationDefinition.name &&
            (n.params as { message?: { parts?: unknown[] } }).message?.parts !==
              undefined,
        ).length;
        // With the bypass flag honored, exactly one notification
        // arrives (the broadcaster's). Without the fix, two would
        // arrive (network.send self-loop + broadcaster).
        expect(receivedCount).toBe(1);
      }),
    20_000,
  );
});
