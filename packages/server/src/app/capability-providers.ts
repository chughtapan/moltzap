/**
 * @file Named capability providers — #705 HALF-1.
 *
 * Each cap-bearing method threads a positional provider tuple (aligned
 * 1:1 to its descriptor's `capabilities` array) into
 * `defineXMethod(definition, def, [...providers])`; the slot's `invoke`
 * ({@link makeErasedSlot}) discharges them in declaration order. The
 * pre-HALF-1 global `serverCapabilityProviders` table (keyed by
 * `Context.Tag.key`, consumed by the now-deleted dispatcher
 * `applyCapabilityProvisioning`) is gone; the inhabitants are the named
 * `provideX` functions below.
 *
 * Each provider unwraps the slot-supplied `args` (built by the
 * descriptor's `argsOf(params, ctx)` resolver) via a single-level `as`
 * cast and runs the capability composition. Simple obtains live INLINE
 * here; composites with their own direct consumers live as named
 * functions next to the services they compose
 * (`obtainMessageSendPermission` and
 * `obtainConversationCreateAuthorization` in `task/services/`).
 *
 * The pattern this table closes the loop on: privileged service
 * preconditions live in the method's *type signature* (its `R`
 * channel), not in a runtime `requireX` call inside the body. The
 * compiler is the gate.
 *
 * ```ts
 * // Descriptor declares capabilities.
 * export const TaskConversationArchive = defineRpc({
 *   name: "task/conversation/archive",
 *   params: TaskConversationArchiveParams,
 *   result: TaskConversationArchiveResult,
 *   capabilities: [
 *     { tag: ConversationInTask, argsOf: (p) => ({ taskId: p.taskId, conversationId: p.conversationId }) },
 *   ],
 * });
 *
 * // Service method R channel encodes the preconditions.
 * archiveTaskConversation(...): Effect.Effect&lt;..., ConversationServiceError, ConversationInTask>;
 *
 * // Handler body just yields the tags — no Effect.provideServiceEffect chain.
 * ```
 *
 * Two capability shapes:
 *
 * - **Obtain shape** (`obtain*`) — queries the DB (or an `@internal`
 *   service helper) and returns `{tag, payload row}`. Payload rides
 *   inside the capability value so service bodies do not re-fetch.
 * - **Refine shape** (`refine*`) — validates an already-fetched row
 *   inline (no DB read). Used inside composite obtain helpers like
 *   `obtainMessageSendPermission` after `readSendConversation`.
 *   Refine helpers are LIVENESS proofs scoped to the request fiber's
 *   transaction; cross-transaction reuse is a defect.
 *
 * Composite capabilities (`MessageSendPermission`): Effect's R
 * channel union encodes a *set of required services*
 * (`Effect&lt;A, E, T1 | T2>` requires BOTH). There is no native
 * "exactly one of" in `provideServiceEffect`. The composite ships as
 * one `Context.Tag` whose value is a discriminated union over the
 * legal authorization paths (`forParticipantOnActiveTask`,
 * `forTmBypass`, `forTmBypassWithReply`). The handler picks the
 * right constructor at provision time; the service body destructures
 * via `_tag`.
 *
 * `MessagesSend` is the one structural exception to descriptor-side
 * capability declaration: its wire schema accepts
 * `(conversationId | to | replyToId)` and the handler must resolve
 * `conversationId` via DB lookup before `MessageSendPermission` can
 * be obtained. Its capability stays hand-piped at the handler call
 * site — see `messages.ts → MessagesSend`.
 *
 * Gate-helper visibility (`@internal` exported, not `private`): TS
 * `private` blocks obtain helpers from reaching service checks via
 * the service Tag regardless of DI path. Gates stay on the service
 * class as `@internal` exported instance methods.
 *
 * Adding a new capability:
 *
 *   1. Tag + value type in `@moltzap/protocol/task/capabilities/&lt;name>.ts`
 *      (pure protocol types, no server deps).
 *   2. Obtain logic: inline in this file for a simple obtain, or as
 *      a named function in `task/services/&lt;name>.ts` for a composite
 *      that has its own direct consumer.
 *   3. Service method R channel gains the tag; body yields it.
 *   4. Descriptor's `capabilities: [...]` array adds
 *      `{ tag, argsOf }`.
 *   5. Provider table (this file) adds `[Tag.key]: (args) => obtain...`.
 *
 * Compile-time gate (`typed-dispatcher.types-check.ts → Canary 7`)
 * rejects any handler whose R channel yields a tag NOT declared on
 * its descriptor.
 */
import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  ConversationId,
  TaskId,
  ObtainMessageSendPermissionInput,
} from "@moltzap/protocol/task";
import { ConversationServiceTag, TaskServiceTag } from "./layers.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";
import { obtainMessageSendPermission } from "../task/services/message-send-permission.js";

interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

// #705 HALF-1 — per-method positional provider tuples. The pre-cutover
// global `serverCapabilityProviders` table (keyed by `Context.Tag.key`)
// is gone; each cap-bearing method threads the matching provider(s) as a
// positional tuple aligned 1:1 to its descriptor's `capabilities` array
// (the `CapProviders<CapsTuple, Env>` lockstep). The named providers
// below are the inhabitants; handlers compose them into tuples at the
// `defineXMethod(definition, def, [...providers])` call site.
//
// Each provider receives the dispatcher-derived args (built by the
// descriptor's `argsOf(params, ctx)`), narrows via a single-level `as`
// cast (HALF-2 tightens these), and returns the capability's effect.

/** Provider for `TaskReadAccess` (`messages/list`). */
export const provideTaskReadAccess = (args: unknown) => {
  // #ignore-sloppy-code-next-line[params-cast]: provider re-imposes the descriptor-derived args shape (dispatcher-boundary erasure carve-out, HALF-2 tightens)
  const { taskId, callerAgentId } = args as TaskAndAgent;
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskWithReadAccess(
      taskId,
      callerAgentId,
    );
    return { task, callerAgentId };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));
};

/**
 * Provider for `ConversationInTask` (`messages/send`, `messages/list`,
 * the four `task/conversation/*` admin RPCs).
 */
export const provideConversationInTask = (args: unknown) => {
  // #ignore-sloppy-code-next-line[params-cast]: provider re-imposes the descriptor-derived args shape (dispatcher-boundary erasure carve-out, HALF-2 tightens)
  const { taskId, conversationId } = args as TaskAndConversation;
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.assertConversationInTask(taskId, conversationId);
    return { taskId, conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));
};

/** Provider for `ContactPolicyAllowsReach` (`task/request`). */
export const provideContactPolicyAllowsReach = (args: unknown) => {
  // #ignore-sloppy-code-next-line[params-cast]: provider re-imposes the descriptor-derived args shape (dispatcher-boundary erasure carve-out, HALF-2 tightens)
  const { creatorAgentId, targetAgentIds } = args as CreatorAndTargets;
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId =
        yield* conversations.loadAgentOwners(targetAgentIds);
      yield* conversations.assertContactPolicyForCreate(
        creatorAgentId,
        targetAgentIds,
        ownerByAgentId,
      );
      return { creatorAgentId, targetAgentIds };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));
};

/** Provider for `MessageSendPermission` (`messages/send`). */
export const provideMessageSendPermission = (args: unknown) =>
  // #ignore-sloppy-code-next-line[params-cast]: provider re-imposes the descriptor-derived args shape (dispatcher-boundary erasure carve-out, HALF-2 tightens)
  obtainMessageSendPermission(args as ObtainMessageSendPermissionInput);
