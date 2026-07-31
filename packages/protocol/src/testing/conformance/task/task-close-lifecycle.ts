/**
 * Task close lifecycle — close is observable as task/closed, and a
 * conversation under the closed task rejects later traffic.
 */
import { Effect } from "effect";
import {
  taskClosedNotificationDefinition,
  taskRequest,
  taskUpdate,
  type TaskId,
} from "#task";
import { conversationCreate } from "#conversation";
import {
  type ModeratedHandle,
  DELIVERY_DEFAULT_TIMEOUT_MS,
  acquireClient,
  assertConversationRejectsMessages,
  awaitOneNotification,
  deliveryViolation,
  moderateAs,
  type ConversationActor,
} from "./_helpers.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import { registerProperty } from "../_shared/registry.js";
import { requireRight } from "../_shared/_helpers.js";

// Property ID stays `delivery/task-close-lifecycle`: the registry
// `category` derives from the call-site, not the file path.
const CATEGORY = "delivery";
const PROPERTY = "task-close-lifecycle";

/**
 * Registers task close lifecycle.
 * @param ctx Context for the operation.
 */
export function registerTaskCloseLifecycle(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "tasks/close broadcasts task/closed and gates agent/message/send",
    runTaskCloseLifecycle(ctx).pipe(
      Effect.withSpan("registerTaskCloseLifecycle"),
    ),
  );
}

interface TaskClosedEventData {
  readonly task?: {
    readonly id?: unknown;
    readonly status?: unknown;
  };
}

function runTaskCloseLifecycle(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* acquireTaskCloseFixture(ctx);
      // tasks/close heads its `requires` with `AppPrincipal` — drive it through
      // the moderator app principal, not the agent owner.
      const close = yield* fixture.moderatorClient
        .sendRpc(taskUpdate, { action: "close", taskId: fixture.taskId })
        .pipe(Effect.either);
      const closed = yield* requireRight(close, (error) =>
        deliveryViolation(PROPERTY, `tasks/close failed: ${error._tag}`),
      );
      if (closed.action !== "closed" || closed.task.status !== "closed") {
        return yield* Effect.fail(
          deliveryViolation(
            PROPERTY,
            `tasks/close returned ${JSON.stringify(closed)}`,
          ),
        );
      }
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
        expectedError: { tag: "TaskClosed" },
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

// `agent/task/request` is agent-called by `owner`; participant mutation routes
// through the moderator app principal.
function createTaskAndAddParticipant(
  owner: ConversationActor,
  participant: ConversationActor,
  moderator: ModeratedHandle,
) {
  return Effect.gen(function* () {
    const taskResult = yield* owner.client
      .sendRpc(taskRequest, {
        appId: moderator.appId,
        invitedAgentIds: [participant.agent.agentId],
      })
      .pipe(Effect.either);
    const task = yield* requireRight(taskResult, (error) =>
      deliveryViolation(PROPERTY, `agent/task/request failed: ${error._tag}`),
    );
    const addResult = yield* moderator.client
      .sendRpc(taskUpdate, {
        action: "add-participant",
        taskId: task.task.id,
        agentId: participant.agent.agentId,
      })
      .pipe(Effect.either);
    yield* requireRight(addResult, (error) =>
      deliveryViolation(PROPERTY, `app/task/update failed: ${error._tag}`),
    );
    return task;
  });
}

// `app/conversation/create` heads its `requires` with `AppPrincipal` — the
// moderator app creates it. `owner` is included as a participant so its subscriber
// observes the `app/conversation/created` event (`awaitConversationReady`
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
      .sendRpc(conversationCreate, {
        taskId,
        participants: [owner.agent.agentId, participant.agent.agentId],
      })
      .pipe(Effect.either);
    return yield* requireRight(conversationResult, (error) =>
      deliveryViolation(
        PROPERTY,
        `app/conversation/create failed: ${error._tag}`,
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
      taskClosedNotificationDefinition,
      DELIVERY_DEFAULT_TIMEOUT_MS,
    ).pipe(
      Effect.mapError((reason) =>
        deliveryViolation(propertyName, `task/closed event missing: ${reason}`),
      ),
    );
    const data =
      /* Safe because awaitOneNotification was parameterized with taskClosedNotificationDefinition. */ event.params as
        | TaskClosedEventData
        | undefined;
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
