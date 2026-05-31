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
  TaskRequest,
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

// Property ID stays `delivery/task-close-lifecycle`: the registry
// `category` derives from the call-site, not the file path.
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
      // tasks/close is `callablePrincipal: "app"` — drive it through the
      // moderator app principal, not the agent owner.
      const close = yield* fixture.moderatorClient
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
    const moderator = yield* moderateAs(ctx, owner, "tc").pipe(
      Effect.mapError((message) => deliveryViolation(PROPERTY, message)),
    );
    const task = yield* createTaskAndAddParticipant(
      owner,
      participant,
      moderator,
    );
    const conversation = yield* createTaskCloseConversation(
      moderator,
      task.task.id,
      owner,
      participant,
    );
    yield* moderator
      .awaitConversationReady(conversation.conversation.id, [
        owner.agent.agentId,
        participant.agent.agentId,
      ])
      .pipe(Effect.mapError((message) => deliveryViolation(PROPERTY, message)));
    return {
      owner,
      participant,
      moderatorClient: moderator.client,
      taskId: task.task.id,
      conversationId: conversation.conversation.id,
    };
  });
}

// `task/request` is agent-called by `owner`; `task/addParticipant` is
// `callablePrincipal: "app"` and routes through the moderator app principal.
function createTaskAndAddParticipant(
  owner: ConversationActor,
  participant: ConversationActor,
  moderator: ModeratedHandle,
) {
  return Effect.gen(function* () {
    const taskResult = yield* owner.client
      .sendRpc(TaskRequest, {
        appId: moderator.appId,
        invitedAgentIds: [participant.agent.agentId],
      })
      .pipe(Effect.either);
    const task = yield* requireRight(taskResult, (error) =>
      deliveryViolation(PROPERTY, `task/create failed: ${error._tag}`),
    );
    const addResult = yield* moderator.client
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

// `task/conversation/create` is `callablePrincipal: "app"` — the moderator
// app creates it. `owner` is included as a participant so its subscriber
// observes the `task/conversation/created` event (`awaitConversationReady`
// polls a map fed by the owner's agent-broadcast stream; an `AppConnection`
// cannot receive that broadcast).
function createTaskCloseConversation(
  moderator: ModeratedHandle,
  taskId: TaskId,
  owner: ConversationActor,
  participant: ConversationActor,
) {
  return Effect.gen(function* () {
    const conversationResult = yield* moderator.client
      .sendRpc(TaskConversationCreate, {
        taskId,
        participants: [owner.agent.agentId, participant.agent.agentId],
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
