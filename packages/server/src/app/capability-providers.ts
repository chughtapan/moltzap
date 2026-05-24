/**
 * @file Shared capability provider table for `makeServerConnection`.
 *
 * The dispatcher's auto-provision path (`applyCapabilityProvisioning`
 * in `@moltzap/protocol/transport/dispatch.ts`) keys obtain helpers
 * by each `Context.Tag.key` declared on the descriptor's
 * `RpcDefinition.capabilities` array. Both `makeServerConnection`
 * call sites pass an IDENTICAL provider table, extracted here.
 *
 * Each provider unwraps the dispatcher-supplied `args` (built by the
 * descriptor's `argsOf(params, ctx)` resolver) via a single-level `as`
 * cast and runs the capability composition. Simple obtains live INLINE
 * here (each has exactly one consumer — this table); composites with
 * their own direct consumers live as named functions next to the
 * services they compose (`obtainMessageSendPermission` and
 * `obtainConversationCreateAuthorization` in `task/services/`).
 *
 * The pattern this table closes the loop on: privileged service
 * preconditions live in the method's *type signature* (its `R`
 * channel), not in a runtime `requireX` call inside the body. The
 * compiler is the gate.
 *
 * ```ts
 * // Descriptor declares capabilities.
 * export const TaskConversationCreate = defineRpc({
 *   name: "task/conversation/create",
 *   params: TaskConversationCreateParams,
 *   result: TaskConversationCreateResult,
 *   capabilities: [
 *     { tag: TmAuthority,                     argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
 *     { tag: ConversationCreateAuthorization, argsOf: (p, ctx) => ({ agentIds: [...p.participants], creatorAgentId: ctx.auth.agentId }) },
 *   ],
 * });
 *
 * // Service method R channel encodes the preconditions.
 * create(...): Effect.Effect&lt;Conversation, ConversationServiceError, ConversationCreateAuthorization>;
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
import { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
  AppId,
  ContactPolicyAllowsReach,
  ConversationCreateAuthorization,
  ConversationInTask,
  MessageSendPermission,
  TaskReadAccess,
  TmAuthority,
  type ConversationId,
  type TaskId,
  type ObtainConversationCreateAuthorizationInput,
  type ObtainMessageSendPermissionInput,
} from "@moltzap/protocol/task";
import { Value } from "@sinclair/typebox/value";
import {
  AppHostTag,
  ConversationServiceTag,
  TaskServiceTag,
} from "./layers.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";
import { obtainMessageSendPermission } from "../task/services/message-send-permission.js";
import { obtainConversationCreateAuthorization } from "../task/services/conversation-create-authorization.js";

interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

interface TaskAndConn {
  readonly taskId: TaskId;
  readonly callerConnId: ConnectionId;
}

interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

const ERR_NOT_TM = "Caller is not the registered task manager for this task";

/**
 * Provider table keyed by `Context.Tag.key`. Each entry receives the
 * dispatcher-derived args (built by the descriptor's `argsOf`), narrows
 * via a single-level `as` cast, and returns the capability's effect.
 *
 * Both `makeServerConnection` call sites pass this same constant so the
 * `Caps` generic of `ServerConnectionConfig` agrees across them.
 */
export const serverCapabilityProviders = {
  [TmAuthority.key]: (args: unknown) => {
    const { taskId, callerConnId } = args as TaskAndConn;
    return Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      const appHost = yield* AppHostTag;
      const task = yield* taskService.loadOpenTask(taskId);
      const taskAppId = Value.Decode(AppId, task.appId);
      if (!appHost.isAppConnection(taskAppId, callerConnId)) {
        return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
      }
      return { task };
    }).pipe(Effect.withSpan("obtainTmAuthority"));
  },
  [TaskReadAccess.key]: (args: unknown) => {
    const { taskId, callerAgentId } = args as TaskAndAgent;
    return Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      const task = yield* taskService.loadTaskWithReadAccess(
        taskId,
        callerAgentId,
      );
      return { task, callerAgentId };
    }).pipe(Effect.withSpan("obtainTaskReadAccess"));
  },
  [ConversationInTask.key]: (args: unknown) => {
    const { taskId, conversationId } = args as TaskAndConversation;
    return Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      yield* taskService.assertConversationInTask(taskId, conversationId);
      return { taskId, conversationId };
    }).pipe(Effect.withSpan("obtainConversationInTask"));
  },
  [ContactPolicyAllowsReach.key]: (args: unknown) => {
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
  },
  [ConversationCreateAuthorization.key]: (args: unknown) =>
    obtainConversationCreateAuthorization(
      args as ObtainConversationCreateAuthorizationInput,
    ),
  [MessageSendPermission.key]: (args: unknown) =>
    obtainMessageSendPermission(args as ObtainMessageSendPermissionInput),
} as const;
