/**
 * End-to-end coverage for `messages/send` → TM routing via
 * `network.send` and the surrounding fail-closed branches.
 *
 * Surviving contracts pinned by the suite:
 *  - Custom-TM routing: TM live → success; TM offline → HookBlocked.
 *  - Closed task: `messages/send` fails closed with `TaskClosed`.
 *  - TM-authored `messages/send` does NOT self-loop the TM (codex HIGH-1).
 *  - Default-DM-TM lifecycle: `TaskCreate` with `initialConversation`
 *    auto-mints a default-TM-bound task; `messages/send` succeeds.
 */
import * as fc from "fast-check";
import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Chunk, Duration, Effect, Fiber, Stream } from "effect";
import {
  DEFAULT_APP_ID,
  HookBlockedError,
  MessageReceivedNotificationDefinition,
  MessagesSend,
  TaskClose,
  TaskClosedError,
  TaskCreate,
  type ConversationId,
  type Message,
  type Task,
} from "@moltzap/protocol";
import {
  conversationId as makeConversationId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";
import {
  awaitOneNotification,
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  registerAgent,
  expectEitherLeft,
  type ServerTestClient,
} from "../helpers.js";

const TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS = 20_000;
const PROPERTY_RUNS = 25;
const TASK_CLOSED_REASON = "TaskClosed";
const CLOSED_STATUS = "closed";

let baseUrl: string;
let wsUrl: string;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect();
      baseUrl = server.baseUrl;
      wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() => Effect.runPromise(resetTestDbEffect()));

interface AgentPair {
  readonly tm: ServerTestClient;
  readonly tmAgentId: string;
  readonly sender: ServerTestClient;
  readonly senderAgentId: string;
}

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
  readonly conversationId: ConversationId;
}

/**
 * Stand up a task with the TM agent as creator + the sender as
 * participant, plus a task-bound conversation.
 */
function setupTaskBoundConversation(
  pair: AgentPair,
): Effect.Effect<TaskBinding, Error> {
  return Effect.gen(function* () {
    // Single TaskCreate auto-admits + atomically mints the conversation.
    // Pre-#677 this used TaskAddParticipant + TaskConversationCreate,
    // both TM-only on DEFAULT_APP_ID tasks (unreachable by design).
    const created = yield* pair.tm.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [pair.senderAgentId],
      initialConversation: { participants: [pair.senderAgentId] },
    });
    return {
      taskId: created.task.id,
      conversationId: created.conversation!.id,
    };
  });
}

it("property: task binding carries both task and conversation IDs", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (rawTask, rawConv) => {
        const binding: TaskBinding = {
          taskId: makeTaskId(rawTask),
          conversationId: makeConversationId(rawConv),
        };
        expect(binding.taskId).toBe(rawTask);
        expect(binding.conversationId).toBe(rawConv);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  }));

it(
  "TM live: messages/send to a task-bound conversation succeeds",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(1);
      const { taskId, conversationId } =
        yield* setupTaskBoundConversation(pair);

      const sent = yield* pair.sender.sendRpc(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: "hi TM" }],
      });
      const message: Message = sent.message;
      expect(message.parts).toEqual([{ type: "text", text: "hi TM" }]);

      const received = yield* awaitOneNotification(
        pair.tm,
        MessageReceivedNotificationDefinition,
      );
      const receivedMsg = (received.params as { message: Message }).message;
      expect(receivedMsg.id).toBe(message.id);
      expect(receivedMsg.parts).toEqual([{ type: "text", text: "hi TM" }]);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);

it(
  "TM offline: messages/send surfaces RpcFailure (RecipientNotResolved → HookBlocked)",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(2);
      const { taskId, conversationId } =
        yield* setupTaskBoundConversation(pair);

      yield* pair.tm.close();
      yield* Effect.sleep("100 millis");

      const outcome = yield* Effect.either(
        pair.sender.sendRpc(MessagesSend, {
          taskId,
          conversationId,
          parts: [{ type: "text", text: "tm offline" }],
        }),
      );
      const err = expectEitherLeft(outcome) as {
        code?: number;
        message?: string;
      };
      expect(err.code).toBe(HookBlockedError.code);
      expect(err.message).toMatch(/Task manager/i);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);

it(
  "Closed task: messages/send fails closed with TaskClosed",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(4);
      const { taskId, conversationId } =
        yield* setupTaskBoundConversation(pair);

      yield* pair.sender.sendRpc(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: "before close" }],
      });

      yield* pair.tm.sendRpc(TaskClose, { taskId });

      const outcome = yield* Effect.either(
        pair.sender.sendRpc(MessagesSend, {
          taskId,
          conversationId,
          parts: [{ type: "text", text: "after close" }],
        }),
      );
      const err = expectEitherLeft(outcome) as {
        code?: number;
        message?: string;
        data?: { reason?: string; status?: string };
      };
      expect(err.code).toBe(TaskClosedError.code);
      expect(err.data?.reason).toBe(TASK_CLOSED_REASON);
      expect(err.data?.status).toBe(CLOSED_STATUS);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);

it(
  "Default-DM-TM: TaskCreate auto-binds the default TM; messages/send succeeds without a custom TM",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(5);
      const conv = yield* pair.sender.sendRpc(TaskCreate, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [pair.tmAgentId],
        initialConversation: { participants: [pair.tmAgentId] },
      });

      const sent = yield* pair.sender.sendRpc(MessagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
        parts: [{ type: "text", text: "hello default TM" }],
      });
      expect(sent.message.parts).toEqual([
        { type: "text", text: "hello default TM" },
      ]);

      const received = yield* awaitOneNotification(
        pair.tm,
        MessageReceivedNotificationDefinition,
      );
      const receivedMsg = (received.params as { message: Message }).message;
      expect(receivedMsg.id).toBe(sent.message.id);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);

it(
  "Default-group-TM: TaskCreate type=group auto-binds the default group TM",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(7);
      // Add a third agent to push cardinality into "group" derivation.
      const observerReg = yield* registerAgent(baseUrl, "group-observer-7");
      const observer = yield* connectTestClient({
        wsUrl,
        agentId: observerReg.agentId,
        apiKey: observerReg.apiKey,
      });
      trackClient(observer);
      const tmAgentId = pair.tmAgentId;
      const observerAgentId = observerReg.agentId;
      const conv = yield* pair.sender.sendRpc(TaskCreate, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [tmAgentId, observerAgentId],
        initialConversation: {
          name: "default-group-tm",
          participants: [tmAgentId, observerAgentId],
        },
      });

      const sent = yield* pair.sender.sendRpc(MessagesSend, {
        taskId: conv.task.id,
        conversationId: conv.conversation!.id,
        parts: [{ type: "text", text: "group with default TM" }],
      });
      expect(sent.message.parts).toEqual([
        { type: "text", text: "group with default TM" },
      ]);

      const received = yield* awaitOneNotification(
        pair.tm,
        MessageReceivedNotificationDefinition,
      );
      const receivedMsg = (received.params as { message: Message }).message;
      expect(receivedMsg.id).toBe(sent.message.id);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);

it(
  "TM-authored messages/send does not self-loop the TM via network.send (codex HIGH-1)",
  () =>
    Effect.gen(function* () {
      const pair = yield* setupTmAndSender(6);
      const { taskId, conversationId } =
        yield* setupTaskBoundConversation(pair);

      const SETTLE_MS = 200;
      const tmCollector = yield* pair.tm
        .subscribe(MessageReceivedNotificationDefinition)
        .pipe(
          Stream.filter(
            (n) =>
              (n.params as { message?: { parts?: unknown[] } }).message
                ?.parts !== undefined,
          ),
          Stream.interruptAfter(Duration.millis(SETTLE_MS)),
          Stream.runCollect,
          Effect.fork,
        );

      yield* pair.tm.sendRpc(MessagesSend, {
        taskId,
        conversationId,
        parts: [{ type: "text", text: "stored by TM" }],
      });

      const received = Chunk.toReadonlyArray(yield* Fiber.join(tmCollector));
      expect(received).toHaveLength(1);
    }),
  TASK_MANAGER_ROUTING_TEST_TIMEOUT_MS,
);
