import { Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol";
import type { TaskId, ConversationId } from "@moltzap/protocol/task";
import type { ConversationInTaskValue } from "./conversation-in-task.js";
import type { TmAuthorityValue } from "./tm-authority.js";

/**
 * Runtime equality check: the capability's carried `taskId` matches
 * the caller-passed `expectedTaskId`. One-line guard at the start of
 * every service method that consumes a capability + a separate `taskId`
 * handler-input — catches the "handler obtained capability for task A
 * but passed task B" bug at a token cost (one comparison).
 *
 * Spec #601 §Invariants: "performs ONE runtime equality check per
 * operation". For methods that consume capabilities WITHOUT an
 * independent `taskId` argument (because the capability IS the taskId
 * source), this helper is unused.
 *
 * Variants below mirror each capability's carried-ID shape; new
 * capabilities add a sibling overload here as part of their Phase X PR.
 */

const ERR_CAP_TASK_MISMATCH = "capability/task mismatch";
const ERR_CAP_CONV_MISMATCH = "capability/conversation mismatch";

/**
 * Verifies `cap.task.id === expectedTaskId`. Fails with
 * `ForbiddenError` when the handler obtained a capability for one task
 * but passed a different `taskId` argument to the service method.
 */
export const assertTmAuthorityMatchesTask = (
  cap: TmAuthorityValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> => {
  if (cap.task.id !== expectedTaskId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_TASK_MISMATCH }));
  }
  return Effect.void;
};

/**
 * Verifies the capability's carried `(taskId, conversationId)` pair
 * equals the expected pair. Fails with `ForbiddenError` on the first
 * mismatch; runs both comparisons in one Effect for handler-side
 * symmetry with `assertTmAuthorityMatchesTask`.
 */
export const assertConversationInTaskMatches = (
  cap: ConversationInTaskValue,
  expectedTaskId: TaskId,
  expectedConversationId: ConversationId,
): Effect.Effect<void, ForbiddenError> => {
  if (cap.taskId !== expectedTaskId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_TASK_MISMATCH }));
  }
  if (cap.conversationId !== expectedConversationId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_CONV_MISMATCH }));
  }
  return Effect.void;
};
