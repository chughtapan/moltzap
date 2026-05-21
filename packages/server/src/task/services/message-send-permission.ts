import { Cause, Effect } from "effect";
import {
  ForbiddenError,
  type ConversationArchivedError,
  type NotFoundError,
  type Task,
  type TaskClosedError,
} from "@moltzap/protocol";
import {
  type MessageSendPermissionValue,
  type ObtainMessageSendPermissionInput,
  refineConversationNotArchived,
  refineTaskActive,
  type ConversationId,
  type MessageId,
  type TaskId,
} from "@moltzap/protocol/task";
import {
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../../app/layers.js";
import {
  endpointAddressForAgent,
  type TaskServiceError,
} from "./task.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type { MessageService } from "./message.service.js";

/**
 * Smart constructor for `MessagesSend`. Composes the full precondition
 * set behind ONE `Effect.provideServiceEffect` call.
 *
 * Flow (Phase 4 also drives the matching service-method shape):
 *   1. Look up the send-projection row via
 *      `MessageService.readSendConversation` (joins `conversations ⋈
 *      tasks`; promoted to `@internal` in Phase 1).
 *   2. Prove caller is a conversation participant via
 *      `ConversationService.assertConversationParticipant`.
 *   3. Refine `conversation.archived_at IS NULL` via
 *      `refineConversationNotArchived` (no DB read; uses column).
 *   4. Decide TM-bypass by comparing
 *      `conv.tm_endpoint_address === endpointAddressForAgent(sender)`.
 *   5. Fetch the task row via `TaskService.fetchTask` (promoted to
 *      `@internal` in Phase 1) — carried in every variant's `task`
 *      payload field.
 *   6. Resolve the reply target: when present, verify via
 *      `MessageService.assertReplyTarget`.
 *   7. Non-bypass: refine `task.status` via `refineTaskActive` and
 *      return `forParticipantOnActiveTask`.
 *      Bypass + no reply: return `forTmBypass`.
 *      Bypass + reply: return `forTmBypassWithReply`.
 *
 * Error channel — union of every source-service public failure that
 * the body propagates without rewrap:
 *   - `ForbiddenError` from `assertConversationParticipant`
 *   - `NotFoundError` from `assertReplyTarget`, `fetchTask`
 *   - `ConversationArchivedError` from `refineConversationNotArchived`
 *   - `TaskClosedError` from `refineTaskActive`
 */
type ReplyTargetValue =
  | { readonly _tag: "ValidReply"; readonly replyToId: MessageId }
  | { readonly _tag: "NoReply" };

const resolveReplyTarget = (
  conversationId: ConversationId,
  replyToId: MessageId | undefined,
): Effect.Effect<ReplyTargetValue, NotFoundError, MessageServiceTag> => {
  if (replyToId === undefined) {
    return Effect.succeed({ _tag: "NoReply" } as const);
  }
  return Effect.gen(function* () {
    const msgService = yield* MessageServiceTag;
    yield* catchSqlErrorAsDefect(
      msgService.assertReplyTarget(conversationId, replyToId),
    );
    return { _tag: "ValidReply", replyToId } as const;
  });
};

type SendConversationRow = Effect.Effect.Success<
  ReturnType<MessageService["readSendConversation"]>
>;

/**
 * Reads the send-conversation projection AFTER the participant check
 * has already proved the conversation exists. A `NoSuchElement` here
 * is therefore a true defect (race with archival/deletion); convert
 * it to a die-cause so the caller's `catchSqlErrorAsDefect` reports it
 * as a 500 rather than a user-visible error.
 */
const readSendConversationStrict = (
  conversationId: ConversationId,
): Effect.Effect<SendConversationRow, never, MessageServiceTag> =>
  Effect.gen(function* () {
    const msgService = yield* MessageServiceTag;
    return yield* catchSqlErrorAsDefect(
      msgService
        .readSendConversation(conversationId)
        .pipe(
          Effect.catchTag("NoSuchElementException", (cause) =>
            Effect.die(new Cause.IllegalArgumentException(String(cause))),
          ),
        ),
    );
  });

/**
 * Guards the `conv.task_id === input.taskId` invariant (codex review
 * #601 R1). Without this, the carried `task` payload (fetched by
 * `taskService.fetchTask(input.taskId)`) could refer to a different
 * task than the `conv.task_status` / `conv.tm_endpoint_address`
 * columns used for the TM-bypass branch.
 */
const assertConvBelongsToTask = (
  conv: SendConversationRow,
  taskId: TaskId,
): Effect.Effect<void, ForbiddenError> => {
  if (conv.task_id !== taskId) {
    return Effect.fail(
      new ForbiddenError({
        message: "Conversation does not belong to the specified task",
      }),
    );
  }
  return Effect.void;
};

const buildPermissionForTmBypass = (
  task: Task,
  input: ObtainMessageSendPermissionInput,
  replyTarget: ReplyTargetValue,
): MessageSendPermissionValue => {
  if (replyTarget._tag === "NoReply") {
    return {
      _tag: "forTmBypass" as const,
      task,
      conversationId: input.conversationId,
      senderAgentId: input.senderAgentId,
      replyTarget,
    };
  }
  return {
    _tag: "forTmBypassWithReply" as const,
    task,
    conversationId: input.conversationId,
    senderAgentId: input.senderAgentId,
    replyTarget,
  };
};

export const obtainMessageSendPermission = (
  input: ObtainMessageSendPermissionInput,
): Effect.Effect<
  MessageSendPermissionValue,
  | ForbiddenError
  | NotFoundError
  | ConversationArchivedError
  | TaskClosedError
  | TaskServiceError,
  TaskServiceTag | ConversationServiceTag | MessageServiceTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const convService = yield* ConversationServiceTag;
    // ORDER MATTERS (codex review #601 R1 finding): the participant
    // check must run before the conversation projection — otherwise an
    // unknown `conversationId` falls into `readSendConversation`'s
    // `NoSuchElement` failure path and surfaces as an internal defect
    // (500), regressing the typed `ForbiddenError` today's
    // `sendInsertEffect` raises.
    yield* convService.assertConversationParticipant(
      input.conversationId,
      input.senderAgentId,
    );
    const conv = yield* readSendConversationStrict(input.conversationId);
    // Optional defense: `input.taskId` (when present) MUST match
    // `conv.task_id` — codex review #601 R1. MessagesSend omits the
    // input field; the assertion is a no-op there.
    if (input.taskId !== undefined) {
      yield* assertConvBelongsToTask(conv, input.taskId);
    }
    // ORDER: refineTaskActive precedes refineConversationNotArchived to
    // mirror the pre-Spec-E `sendInsertEffect` ordering
    // (`assertTaskCanReceiveMessage` then `assertConversationOpen`).
    // When the task is closed, the conformance contract expects
    // `TaskClosed` (-32008), not the auto-archive's `ConversationArchived`
    // (-32022). See conformance `delivery/task-close-lifecycle`.
    const isTmBypass =
      conv.tm_endpoint_address === endpointAddressForAgent(input.senderAgentId);
    if (!isTmBypass) {
      yield* refineTaskActive(input.taskId ?? conv.task_id, conv.task_status);
    }
    yield* refineConversationNotArchived(
      input.conversationId,
      conv.archived_at,
    );
    const task = yield* taskService.fetchTask(input.taskId ?? conv.task_id);
    const replyTarget = yield* resolveReplyTarget(
      input.conversationId,
      input.replyToId,
    );
    if (!isTmBypass) {
      const participantPermission: MessageSendPermissionValue = {
        _tag: "forParticipantOnActiveTask",
        task,
        conversationId: input.conversationId,
        senderAgentId: input.senderAgentId,
        replyTarget,
      };
      return participantPermission;
    }
    return buildPermissionForTmBypass(task, input, replyTarget);
  }).pipe(Effect.withSpan("obtainMessageSendPermission"));
