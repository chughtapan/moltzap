import { Cause, Context, Effect } from "effect";
import {
  ForbiddenError,
  type ConversationArchivedError,
  type NotFoundError,
  type Task,
  type TaskClosedError,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import {
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../layers.js";
import {
  endpointAddressForAgent,
  type TaskServiceError,
} from "../../task/services/task.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type { MessageService } from "../../task/services/message.service.js";
import { refineConversationNotArchived } from "./conversation-not-archived.js";
import { refineTaskActive } from "./task-active.js";

/**
 * Composite capability for `MessageService.send` — the load-bearing
 * outcome of **Architect Decision A** in plan #606.
 *
 * ## Why a composite (and not the spec's union-of-tags shape)?
 *
 * Spec #601 §MessagesSend composite shape proposes:
 *   R extends ConversationParticipantAccess
 *           & ConversationInTask
 *           & (TaskActive | TmAuthority)
 *           & (ValidReplyTarget | NoReplyTarget)
 *
 * Effect's R channel uses union types to ENCODE the set of required
 * services — `Effect&lt;A, E, T1 | T2&gt;` requires BOTH `T1` AND `T2`
 * to be provided before the effect is runnable (covariant `R`
 * parameter; each `Effect.provideService(Tag, val)` subtracts exactly
 * the matching `Tag`; remaining tags in the union are still required).
 * There is no native "exactly one of" semantics in
 * `provideServiceEffect`.
 *
 * Concretely:
 * - If we declared `R = TaskActive | TmAuthority` to mean "provide
 *   either", the type system would require the handler to provide BOTH
 *   (or use `Effect.serviceOption` to make consumption optional and
 *   runtime-check internally — losing the compile-time guarantee).
 * - The `capability-r-channel.types-check.ts` canary file in this
 *   directory is the empirical gate: it attempts the union-of-tags shape
 *   under `provideServiceEffect` and shows that providing only one side
 *   leaves the other in `R` (i.e. fails to typecheck). The composite
 *   shape — one tag with three constructors — succeeds.
 *
 * ## Shape
 *
 * `MessageSendPermission` is a single `Context.Tag` whose value is a
 * discriminated union over the three legal authorization paths. The
 * handler picks the right constructor at `provideServiceEffect` time
 * based on `(input.replyToId, taskRow.tm_endpoint_address ===
 * endpointAddressForAgent(ctx.agentId))`; the service body destructures
 * the union via `_tag` and uses the carried proof rows.
 *
 * - `forParticipantOnActiveTask` — caller is a conversation participant
 *   on an OPEN task; optional `replyToId` carried inside the variant.
 * - `forTmBypass` — caller IS the TM (bypasses the "task is open"
 *   gate); replyToId optional.
 * - `forTmBypassWithReply` — TM bypass + the reply target was verified
 *   (folded variant; keeps the discriminated union flat so the body's
 *   exhaustiveness check is one switch).
 *
 * Every variant carries the rows the service body already needs:
 * `task` (for routing), `conversationId`, `senderAgentId`, the resolved
 * reply target (when present).
 */
export type MessageSendPermissionValue =
  | {
      readonly _tag: "forParticipantOnActiveTask";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget:
        | { readonly _tag: "ValidReply"; readonly replyToId: MessageId }
        | { readonly _tag: "NoReply" };
    }
  | {
      readonly _tag: "forTmBypass";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget: { readonly _tag: "NoReply" };
    }
  | {
      readonly _tag: "forTmBypassWithReply";
      readonly task: Task;
      readonly conversationId: ConversationId;
      readonly senderAgentId: AgentId;
      readonly replyTarget: {
        readonly _tag: "ValidReply";
        readonly replyToId: MessageId;
      };
    };

export class MessageSendPermission extends Context.Tag(
  "@moltzap/server/MessageSendPermission",
)<MessageSendPermission, MessageSendPermissionValue>() {}

/**
 * Input shape consumed by the dispatch-time smart constructor. The
 * handler passes the raw `MessagesSend` params + the authenticated
 * `ctx.agentId`; the constructor handles the conversation lookup,
 * participant check, reply-target check, TM-bypass discrimination, and
 * returns the populated discriminated union.
 *
 * This is the ONE call site the handler makes — it replaces the four
 * `Effect.provideServiceEffect` calls the union-of-tags shape would
 * have needed.
 */
export interface ObtainMessageSendPermissionInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly replyToId?: MessageId;
}

/**
 * Smart constructor for `MessagesSend`. Composes the full precondition
 * set behind ONE `Effect.provideServiceEffect` call.
 *
 * Flow (Phase 4 also drives the matching service-method shape):
 *   1. Look up the send-projection row via
 *      `MessageService.readSendConversation` (joins `conversations ⋈
 *      tasks`; promoted to `@internal` in Phase 1).
 *   2. Prove caller is a conversation participant via
 *      `ConversationService.requireParticipant`.
 *   3. Refine `conversation.archived_at IS NULL` via
 *      `refineConversationNotArchived` (no DB read; uses column).
 *   4. Decide TM-bypass by comparing
 *      `conv.tm_endpoint_address === endpointAddressForAgent(sender)`.
 *   5. Fetch the task row via `TaskService.fetchTask` (promoted to
 *      `@internal` in Phase 1) — carried in every variant's `task`
 *      payload field.
 *   6. Resolve the reply target: when present, verify via
 *      `MessageService.requireReplyTarget`.
 *   7. Non-bypass: refine `task.status` via `refineTaskActive` and
 *      return `forParticipantOnActiveTask`.
 *      Bypass + no reply: return `forTmBypass`.
 *      Bypass + reply: return `forTmBypassWithReply`.
 *
 * Error channel — union of every source-service public failure that
 * the body propagates without rewrap:
 *   - `ForbiddenError` from `requireParticipant`
 *   - `NotFoundError` from `requireReplyTarget`, `fetchTask`
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
      msgService.requireReplyTarget(conversationId, replyToId),
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
    yield* convService.requireParticipant(
      input.conversationId,
      input.senderAgentId,
    );
    const conv = yield* readSendConversationStrict(input.conversationId);
    // `input.taskId` MUST match `conv.task_id` — codex review #601 R1.
    yield* assertConvBelongsToTask(conv, input.taskId);
    yield* refineConversationNotArchived(
      input.conversationId,
      conv.archived_at,
    );
    const isTmBypass =
      conv.tm_endpoint_address === endpointAddressForAgent(input.senderAgentId);
    const task = yield* taskService.fetchTask(input.taskId);
    const replyTarget = yield* resolveReplyTarget(
      input.conversationId,
      input.replyToId,
    );
    if (!isTmBypass) {
      yield* refineTaskActive(input.taskId, conv.task_status);
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
