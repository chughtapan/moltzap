import { Cause, Effect } from "effect";
import type {
  ConversationSendAccessValue,
  ConversationId,
} from "@moltzap/protocol/conversation";
import { type TaskId, TaskClosedError } from "@moltzap/protocol/task";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layer.js";
import { MessageServiceTag } from "#message";
import { catchSqlErrorAsDefect } from "#db";

/**
 * `ConversationSendAccess` obtain: prove the caller participates in the
 * conversation, then do the joined read (`conversations ⋈ tasks`). The row it
 * returns is the shared context the send handler guards read from. A
 * `conversationId` that survives the participant check but vanishes from the
 * join is a true race (deletion) — surfaced as a defect, not a user error.
 * @param input Input value to process.
 * @param input.conversationId Value supplied to the operation.
 * @param input.senderAgentId Value supplied to the operation.
 * @param input.taskId Value supplied to the operation.
 * @returns The obtain conversation send access result.
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
      appId: conv.app_id,
      taskStatus: conv.task_status,
    };
  }).pipe(Effect.withSpan("obtainConversationSendAccess"));

// ── Send-precondition handler guards ──────────────────────────────────────────
//
// Send preconditions refine the `ConversationSendAccess` row the requirement
// middleware already fetched. They are HANDLER guards (called at the top of the
// `agent/message/send` body), not standalone middlewares. They take the provided
// row as a value: no DB read, no service env.

/**
 * Refine the task is active (status is NOT `closed`/`failed`).
 * @param row Value supplied to the operation.
 * @returns The guard task active result.
 */
export const guardTaskActive = (
  row: ConversationSendAccessValue,
): Effect.Effect<void, TaskClosedError> =>
  row.taskStatus === "closed" || row.taskStatus === "failed"
    ? Effect.fail(
        new TaskClosedError({
          message: `Task is ${row.taskStatus}`,
          data: {
            reason: "TaskClosed",
            taskId: row.taskId,
            status: row.taskStatus,
          },
        }),
      )
    : Effect.void;
