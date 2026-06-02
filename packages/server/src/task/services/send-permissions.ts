import { Cause, Effect } from "effect";
import {
  ConversationSendAccess,
  type ConversationSendAccessValue,
  type ActiveTaskPermissionValue,
  type OpenConversationPermissionValue,
  type ReplyTargetPermissionValue,
  TaskClosedError,
  ConversationArchivedError,
  ForbiddenError,
  type NotFoundError,
  type ConversationId,
  type MessageId,
  type TaskId,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag, MessageServiceTag } from "../../app/layers.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

/**
 * `ConversationSendAccess` obtain: prove the caller participates in the
 * conversation, then do the ONE joined read (`conversations ⋈ tasks`). The row
 * it returns is the shared context the gating permissions
 * (`ActiveTaskPermission`, `OpenConversationPermission`) read their column off,
 * so the whole send-cap chain costs one joined read. A `conversationId` that
 * survives the participant check but vanishes from the join is a true race
 * (archival/deletion) — surfaced as a defect, not a user error.
 */
export const obtainConversationSendAccess = (input: {
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly taskId?: TaskId;
}): Effect.Effect<
  ConversationSendAccessValue,
  ForbiddenError,
  ConversationServiceTag | MessageServiceTag
> =>
  Effect.gen(function* () {
    const convService = yield* ConversationServiceTag;
    const msgService = yield* MessageServiceTag;
    // Participant check first — an unknown conversationId in the join below
    // would otherwise surface as a 500 instead of ForbiddenError.
    yield* convService.assertConversationParticipant(
      input.conversationId,
      input.senderAgentId,
    );
    const conv = yield* catchSqlErrorAsDefect(
      msgService
        .readSendConversation(input.conversationId)
        .pipe(
          Effect.catchTag("NoSuchElementException", (cause) =>
            Effect.die(new Cause.IllegalArgumentException(String(cause))),
          ),
        ),
    );
    if (input.taskId !== undefined && conv.task_id !== input.taskId) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: "Conversation does not belong to the specified task",
        }),
      );
    }
    return {
      conversationId: input.conversationId,
      taskId: input.taskId ?? conv.task_id,
      // `tasks.app_id` is the branded `AppId` of the task's authorizing app; the
      // DB row types it as a bare string, re-branded here at the read boundary.
      appId: conv.app_id as AppId,
      taskStatus: conv.task_status,
      archivedAt: conv.archived_at,
    };
  }).pipe(Effect.withSpan("obtainConversationSendAccess"));

/**
 * `ActiveTaskPermission` obtain: read the `taskStatus` column off the shared
 * `ConversationSendAccess` row and fail `TaskClosed` when the task is not
 * active. Runs before `OpenConversationPermission` so a closed task surfaces
 * `TaskClosed`, not the auto-archive's `ConversationArchived`.
 */
export const obtainActiveTaskPermission = (): Effect.Effect<
  ActiveTaskPermissionValue,
  TaskClosedError,
  ConversationSendAccess
> =>
  Effect.gen(function* () {
    const ctx = yield* ConversationSendAccess;
    if (ctx.taskStatus === "closed" || ctx.taskStatus === "failed") {
      return yield* Effect.fail(
        new TaskClosedError({
          message: `Task is ${ctx.taskStatus}`,
          data: {
            reason: "TaskClosed",
            taskId: ctx.taskId,
            status: ctx.taskStatus,
          },
        }),
      );
    }
    return { taskId: ctx.taskId, status: ctx.taskStatus };
  }).pipe(Effect.withSpan("obtainActiveTaskPermission"));

/**
 * `OpenConversationPermission` obtain: read the `archivedAt` column off the
 * shared `ConversationSendAccess` row and fail `ConversationArchived` when the
 * conversation is archived.
 */
export const obtainOpenConversationPermission = (): Effect.Effect<
  OpenConversationPermissionValue,
  ConversationArchivedError,
  ConversationSendAccess
> =>
  Effect.gen(function* () {
    const ctx = yield* ConversationSendAccess;
    if (ctx.archivedAt !== null) {
      return yield* Effect.fail(new ConversationArchivedError({}));
    }
    return { conversationId: ctx.conversationId };
  }).pipe(Effect.withSpan("obtainOpenConversationPermission"));

/**
 * `ReplyTargetPermission` obtain: when the send names a `replyToId`, verify the
 * referenced message exists in the conversation (fails `NotFound` if absent);
 * otherwise resolve the `NoReply` sentinel with no DB read.
 */
export const obtainReplyTargetPermission = (input: {
  readonly conversationId: ConversationId;
  readonly replyToId?: MessageId;
}): Effect.Effect<
  ReplyTargetPermissionValue,
  NotFoundError,
  MessageServiceTag
> => {
  if (input.replyToId === undefined) {
    return Effect.succeed({ _tag: "NoReply" });
  }
  const replyToId = input.replyToId;
  return Effect.gen(function* () {
    const msgService = yield* MessageServiceTag;
    yield* catchSqlErrorAsDefect(
      msgService.assertReplyTarget(input.conversationId, replyToId),
    );
    return { _tag: "ValidReply", replyToId } as const;
  }).pipe(Effect.withSpan("obtainReplyTargetPermission"));
};
