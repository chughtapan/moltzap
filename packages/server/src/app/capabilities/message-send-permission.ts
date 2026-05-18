import { Context, Effect } from "effect";
import type {
  ConversationArchivedError,
  ForbiddenError,
  NotFoundError,
  Task,
  TaskClosedError,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import {
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "../layers.js";
import { notImplemented } from "./not-implemented.js";

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
 * services — `Effect&lt;A, E, T1 | T2>` requires BOTH `T1` AND `T2` to be
 * provided before the effect is runnable (covariant `R` parameter; each
 * `Effect.provideService(Tag, val)` subtracts exactly the matching
 * `Tag`; remaining tags in the union are still required). There is no
 * native "exactly one of" semantics in `provideServiceEffect`.
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
 * Architect-stub. Body shape (Phase 4 implements). Column references
 * (`tm_endpoint_address`, `task_status`, `archived_at`, `task_id`) are
 * the projection produced by
 * `MessageService.readSendConversation` — Phase 4 promotes that helper
 * to `@internal` per Decision B and consumes the same projection here.
 *
 *   const taskService = yield* TaskServiceTag;
 *   const convService = yield* ConversationServiceTag;
 *   const msgService = yield* MessageServiceTag;
 *
 *   const conv = yield* msgService.readSendConversation(
 *     input.conversationId);
 *   yield* convService.requireParticipant(input.conversationId,
 *     input.senderAgentId);
 *   yield* refineConversationNotArchived(input.conversationId,
 *     conv.archived_at);
 *
 *   const isTmBypass = conv.tm_endpoint_address ===
 *     endpointAddressForAgent(input.senderAgentId);
 *   const task = yield* taskService.fetchTask(input.taskId); // promote
 *     to `@internal` per Decision B
 *
 *   const replyTarget = input.replyToId === undefined
 *     ? { _tag: "NoReply" as const }
 *     : { _tag: "ValidReply" as const,
 *         replyToId: (yield* obtainValidReplyTarget(
 *           input.conversationId, input.replyToId)).replyToId };
 *
 *   if (!isTmBypass) {
 *     yield* refineTaskActive(input.taskId, conv.task_status);
 *     return { _tag: "forParticipantOnActiveTask",
 *              task, conversationId: input.conversationId,
 *              senderAgentId: input.senderAgentId, replyTarget };
 *   }
 *   if (replyTarget._tag === "NoReply") {
 *     return { _tag: "forTmBypass",
 *              task, conversationId: input.conversationId,
 *              senderAgentId: input.senderAgentId, replyTarget };
 *   }
 *   return { _tag: "forTmBypassWithReply",
 *            task, conversationId: input.conversationId,
 *            senderAgentId: input.senderAgentId, replyTarget };
 *
 * Error channel — union of every source-service public failure that
 * the body propagates without rewrap:
 *   - `ForbiddenError` from `requireParticipant`, `requireTmAuthority`
 *   - `NotFoundError` from `obtainValidReplyTarget`, `fetchTask`
 *   - `ConversationArchivedError` from `refineConversationNotArchived`
 *   - `TaskClosedError` from `refineTaskActive`
 */
export const obtainMessageSendPermission = (
  _input: ObtainMessageSendPermissionInput,
): Effect.Effect<
  MessageSendPermissionValue,
  ForbiddenError | NotFoundError | ConversationArchivedError | TaskClosedError,
  TaskServiceTag | ConversationServiceTag | MessageServiceTag
> => notImplemented("obtainMessageSendPermission") as never;
