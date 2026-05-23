/**
 * Task close lifecycle — close is observable as both conversation
 * archival and task/closed, and the archived task conversation rejects
 * later traffic.
 *
 */
import { Effect } from "effect";
import {
  TaskClosedNotificationDefinition,
  TaskClosedError,
  TaskAddParticipant,
  TaskClose,
  TaskConversationCreate,
  TaskCreate,
} from "../../../task/methods.js";
import type { TaskId } from "../../../task/methods.js";
import type { ModeratedHandle } from "./_helpers.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";
import {
  DELIVERY_DEFAULT_TIMEOUT_MS,
  acquireClient,
  assertConversationRejectsMessages,
  awaitOneNotification,
  deliveryViolation,
  moderateAs,
  waitForArchivedEvent,
  type ConversationActor,
} from "./_helpers.js";

// Property ID stays at `delivery/task-close-lifecycle` to preserve the
// pre/post conformance baseline (#546 §7). Architect §7: "registry
// `category` derived from the call-site, not file path."
const CATEGORY = "delivery" as const;
const PROPERTY = "task-close-lifecycle";

export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "tasks/close archives task conversations and broadcasts task/closed",
    runTaskCloseLifecycle(ctx).pipe(
      Effect.withSpan("registerTaskCloseLifecycle"),
    ),
  );
}

type TaskClosedEventData = {
  readonly task?: {
    readonly id?: unknown;
    readonly status?: unknown;
  };
};

function runTaskCloseLifecycle(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquireTaskCloseFixture(ctx);
      const close = yield* fixture.owner.client
        .sendRpc(TaskClose, { taskId: fixture.taskId })
        .pipe(Effect.either);
      const closed = yield* requireRight(close, (error) =>
        deliveryViolation(PROPERTY, `tasks/close failed: ${error._tag}`),
      );
      if (closed.task.status !== "closed") {
        return yield* Effect.fail(
          deliveryViolation(
            PROPERTY,
            `tasks/close returned status ${closed.task.status}`,
          ),
        );
      }
      yield* waitForArchivedEvent(
        fixture.participant,
        fixture.conversationId,
        fixture.owner.agent.agentId,
        PROPERTY,
      );
      yield* waitForTaskClosedEvent(
        fixture.participant,
        fixture.taskId,
        PROPERTY,
      );
      yield* assertConversationRejectsMessages({
        actor: fixture.participant,
        taskId: fixture.taskId,
        conversationId: fixture.conversationId,
        propertyName: PROPERTY,
        expectedError: { code: TaskClosedError.code, label: "TaskClosed" },
      });
    }),
  );
}

function acquireTaskCloseFixture(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const owner = yield* acquireClient(ctx, "tc-owner").pipe(
      Effect.mapError((e) => deliveryViolation(PROPERTY, `owner: ${e}`)),
    );
    const participant = yield* acquireClient(ctx, "tc-participant").pipe(
      Effect.mapError((e) => deliveryViolation(PROPERTY, `participant: ${e}`)),
    );
    const moderator = yield* moderateAs(owner, "tc").pipe(
      Effect.mapError((message) => deliveryViolation(PROPERTY, message)),
    );
    const task = yield* createTaskAndAddParticipant(
      owner,
      participant,
      moderator.appId,
    );
    const conversation = yield* createTaskCloseConversation(
      owner,
      task.task.id,
      participant,
    );
    yield* moderator
      .awaitConversationReady(conversation.conversation.id, [
        participant.agent.agentId,
      ])
      .pipe(Effect.mapError((message) => deliveryViolation(PROPERTY, message)));
    return {
      owner,
      participant,
      taskId: task.task.id,
      conversationId: conversation.conversation.id,
    };
  });
}

function createTaskAndAddParticipant(
  owner: ConversationActor,
  participant: ConversationActor,
  appId: ModeratedHandle["appId"],
) {
  return Effect.gen(function* () {
    const taskResult = yield* owner.client
      .sendRpc(TaskCreate, {
        appId,
        invitedAgentIds: [participant.agent.agentId],
      })
      .pipe(Effect.either);
    const task = yield* requireRight(taskResult, (error) =>
      deliveryViolation(PROPERTY, `task/create failed: ${error._tag}`),
    );
    const addResult = yield* owner.client
      .sendRpc(TaskAddParticipant, {
        taskId: task.task.id,
        agentId: participant.agent.agentId,
      })
      .pipe(Effect.either);
    yield* requireRight(addResult, (error) =>
      deliveryViolation(PROPERTY, `task/addParticipant failed: ${error._tag}`),
    );
    return task;
  });
}

function createTaskCloseConversation(
  owner: ConversationActor,
  taskId: TaskId,
  participant: ConversationActor,
) {
  return Effect.gen(function* () {
    const conversationResult = yield* owner.client
      .sendRpc(TaskConversationCreate, {
        taskId,
        participants: [participant.agent.agentId],
      })
      .pipe(Effect.either);
    return yield* requireRight(conversationResult, (error) =>
      deliveryViolation(
        PROPERTY,
        `task/conversation/create failed: ${error._tag}`,
      ),
    );
  });
}

function waitForTaskClosedEvent(
  observer: ConversationActor,
  taskId: TaskId,
  propertyName: string,
) {
  return Effect.gen(function* () {
    const event = yield* awaitOneNotification(
      observer.notifications,
      TaskClosedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `task/closed event missing: ${reason}`),
      ),
    );
    const data = event.params as TaskClosedEventData | undefined;
    if (data?.task?.id !== taskId || data.task.status !== "closed") {
      return yield* Effect.fail(
        deliveryViolation(
          propertyName,
          `bad task/closed payload: ${JSON.stringify(event.params)}`,
        ),
      );
    }
  });
}
