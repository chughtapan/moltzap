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
 * descriptor's `argsOf(params, ctx)` resolver) and invokes the
 * matching obtain helper from `app/capabilities/*`.
 *
 * The pattern this table closes the loop on: privileged service
 * preconditions live in the method's *type signature* (its `R`
 * channel), not in a runtime `requireX` call inside the body. The
 * compiler is the gate.
 *
 * ```ts
 * // Descriptor declares capabilities.
 * export const TasksStoreMessage = defineRpc({
 *   name: "tasks/storeMessage",
 *   params: TasksStoreMessageParams,
 *   result: TasksStoreMessageResult,
 *   capabilities: [
 *     { tag: TmAuthority,            argsOf: (p, ctx) => ({ taskId: p.taskId, callerAgentId: ctx.auth.agentId }) },
 *     { tag: ConversationInTask,     argsOf: (p)      => ({ taskId: p.taskId, conversationId: p.conversationId }) },
 *     { tag: MessageSendPermission,  argsOf: (p, ctx) => ({ ... }) },
 *   ],
 * });
 *
 * // Service method R channel encodes the preconditions.
 * storeMessage(...): Effect.Effect&lt;void, MessageServiceError, TmAuthority | ConversationInTask | MessageSendPermission>;
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
 * class as `@internal` exported instance methods; the directory's
 * `app/capabilities/README.md` is the package-internal boundary
 * convention.
 *
 * Adding a new capability:
 *
 *   1. Tag + value type in `@moltzap/protocol/task/capabilities/&lt;name>.ts`
 *      (pure protocol types, no server deps).
 *   2. Obtain helper in `app/capabilities/&lt;name>.ts`.
 *   3. Service method R channel gains the tag; body yields it.
 *   4. Descriptor's `capabilities: [...]` array adds
 *      `{ tag, argsOf }`.
 *   5. Provider table (this file) adds `[Tag.key]: (args) => obtain...`.
 *
 * Compile-time gate (`typed-dispatcher.types-check.ts → Canary 7`)
 * rejects any handler whose R channel yields a tag NOT declared on
 * its descriptor.
 */
import type { AgentId, ConversationId, TaskId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
  ConversationCreateAuthorization,
  ConversationInTask,
  MessageSendPermission,
  TaskReadAccess,
  TmAuthority,
  obtainConversationCreateAuthorization,
  obtainConversationInTask,
  obtainMessageSendPermission,
  obtainTaskReadAccess,
  obtainTmAuthority,
  type ObtainConversationCreateAuthorizationInput,
  type ObtainMessageSendPermissionInput,
} from "./capabilities/index.js";

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

/**
 * Provider table keyed by `Context.Tag.key`. Each entry receives the
 * dispatcher-derived args (built by the descriptor's `argsOf`), narrows
 * via a single-level `as` cast, and returns the obtain helper's effect.
 *
 * Both `makeServerConnection` call sites pass this same constant so the
 * `Caps` generic of `ServerConnectionConfig` agrees across them.
 */
export const serverCapabilityProviders = {
  [TmAuthority.key]: (args: unknown) => {
    const { taskId, callerConnId } = args as TaskAndConn;
    return obtainTmAuthority(taskId, callerConnId);
  },
  [TaskReadAccess.key]: (args: unknown) => {
    const { taskId, callerAgentId } = args as TaskAndAgent;
    return obtainTaskReadAccess(taskId, callerAgentId);
  },
  [ConversationInTask.key]: (args: unknown) => {
    const { taskId, conversationId } = args as TaskAndConversation;
    return obtainConversationInTask(taskId, conversationId);
  },
  [ConversationCreateAuthorization.key]: (args: unknown) =>
    obtainConversationCreateAuthorization(
      args as ObtainConversationCreateAuthorizationInput,
    ),
  [MessageSendPermission.key]: (args: unknown) =>
    obtainMessageSendPermission(args as ObtainMessageSendPermissionInput),
} as const;
