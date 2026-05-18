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

/**
 * Architect-stub. Body shape:
 *   if (cap.task.id !== expectedTaskId) return yield* Effect.fail(
 *     new ForbiddenError({ message: "capability/task mismatch" }));
 *   return Effect.void;
 */
export const assertTmAuthorityMatchesTask = (
  _cap: TmAuthorityValue,
  _expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> =>
  Effect.dieMessage(
    "assertTmAuthorityMatchesTask: Phase 1 implement-staff (#601) supplies the body.",
  );

/**
 * Architect-stub. Body shape mirrors `assertTmAuthorityMatchesTask` but
 * checks `(cap.taskId === expectedTaskId &&
 *        cap.conversationId === expectedConversationId)`.
 */
export const assertConversationInTaskMatches = (
  _cap: ConversationInTaskValue,
  _expectedTaskId: TaskId,
  _expectedConversationId: ConversationId,
): Effect.Effect<void, ForbiddenError> =>
  Effect.dieMessage(
    "assertConversationInTaskMatches: Phase 1 implement-staff (#601) supplies the body.",
  );
