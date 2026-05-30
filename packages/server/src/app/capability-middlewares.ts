/**
 * @file Capability middlewares — #705 HALF-2 slice-1 (cap-as-middleware).
 *
 * The cast-free successors to the `capability-providers.ts` provider
 * functions for the middleware-converted methods (`messages/send`,
 * `messages/list`). Each capability is one {@link CapabilityMiddleware}
 * pairing:
 *   - `provides`: the Spec E `Context.Tag` the handler `yield*`s;
 *   - `derivePayload`: TYPED, payload-only derivation. Reads the decoded
 *     params (A9 — NOT `unknown`, NO `params as Shape` cast) and the
 *     caller's id via `yield* callerAgentId` (`CurrentPrincipal` read — NOT
 *     a `ctx` parameter, NO `narrowToDispatchContext`);
 *   - `obtain`: the effect producing the provided service value (the today
 *     provider body, now typed: input is `derivePayload`'s output, NO
 *     `args as Shape` cast). Its failure rides the obtain `E` → the
 *     dispatcher's existing `wireErrorFromInstance` `-32xxx` projection.
 *
 * The dispatcher weaves these into a STATIC per-arm `provideServiceEffect`
 * chain at the binding site (`messages.handlers.ts`); the chain subtracts
 * each cap tag cast-free and the dispatcher's
 * `provideService(CurrentPrincipal, …)` subtracts the principal — residual
 * R bottoms out at `Env`, compiler-checked (no `dischargeCaps` carve-out).
 */
import { Effect } from "effect";
import {
  ConversationInTask,
  TaskReadAccess,
  MessageSendPermission,
  ContactPolicyAllowsReach,
  callerAgentId,
  type CapabilityMiddleware,
  type ObtainMessageSendPermissionInput,
  type ParamsOf,
  type ConversationId,
  type TaskId,
  MessagesList,
  MessagesSend,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskRequest,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  ConversationServiceTag,
  MessageServiceTag,
  TaskServiceTag,
} from "./layers.js";
import { obtainMessageSendPermission } from "../task/services/message-send-permission.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";

/** Slot env the obtains run under (the converted methods' `TaskSlotEnv`). */
type MwEnv = TaskServiceTag | ConversationServiceTag | MessageServiceTag;

type MessagesListParams = ParamsOf<typeof MessagesList>;
type MessagesSendParams = ParamsOf<typeof MessagesSend>;
type TaskConversationArchiveParams = ParamsOf<typeof TaskConversationArchive>;
type TaskConversationUnarchiveParams = ParamsOf<
  typeof TaskConversationUnarchive
>;
type TaskConversationAddParticipantParams = ParamsOf<
  typeof TaskConversationAddParticipant
>;
type TaskConversationRemoveParticipantParams = ParamsOf<
  typeof TaskConversationRemoveParticipant
>;
type TaskRequestParams = ParamsOf<typeof TaskRequest>;

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

// ── obtains (typed input, no `args as Shape`) ──────────────────────────

const obtainTaskReadAccess = (input: TaskAndAgent) =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskWithReadAccess(
      input.taskId,
      input.callerAgentId,
    );
    return { task, callerAgentId: input.callerAgentId };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));

const obtainConversationInTask = (input: TaskAndConversation) =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.assertConversationInTask(
      input.taskId,
      input.conversationId,
    );
    return { taskId: input.taskId, conversationId: input.conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));

const obtainContactPolicyAllowsReach = (input: CreatorAndTargets) =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(
        input.targetAgentIds,
      );
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.targetAgentIds,
        ownerByAgentId,
      );
      return {
        creatorAgentId: input.creatorAgentId,
        targetAgentIds: input.targetAgentIds,
      };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));

// `Fail` is the obtain's actual error union (derived, not hardcoded) so
// the dispatcher's `wireErrorFromInstance` maps it unchanged.
type TaskReadAccessFail = Effect.Effect.Error<
  ReturnType<typeof obtainTaskReadAccess>
>;
type ConversationInTaskFail = Effect.Effect.Error<
  ReturnType<typeof obtainConversationInTask>
>;
type MessageSendPermissionFail = Effect.Effect.Error<
  ReturnType<typeof obtainMessageSendPermission>
>;
type ContactPolicyAllowsReachFail = Effect.Effect.Error<
  ReturnType<typeof obtainContactPolicyAllowsReach>
>;

// ── middlewares ─────────────────────────────────────────────────────────

/**
 * `TaskReadAccess` middleware (`messages/list` cap[0]). Reads the caller's
 * id via `yield* callerAgentId` (principal-as-service); `taskId` is a typed
 * `params` read.
 */
export const taskReadAccessMiddleware: CapabilityMiddleware<
  MessagesListParams,
  typeof TaskReadAccess,
  TaskAndAgent,
  MwEnv,
  TaskReadAccessFail
> = {
  provides: TaskReadAccess,
  derivePayload: (params) =>
    Effect.gen(function* () {
      return { taskId: params.taskId, callerAgentId: yield* callerAgentId };
    }).pipe(Effect.withSpan("deriveTaskReadAccess")),
  obtain: obtainTaskReadAccess,
};

/**
 * `ConversationInTask` middleware shared by `messages/send` cap[0] +
 * `messages/list` cap[1]. Reads NO principal (pure `params` derivation, R =
 * `never`); generic over the OWNING method's params so both call sites
 * share one typed derive.
 */
const conversationInTaskMiddleware = <
  Params extends TaskAndConversation,
>(): CapabilityMiddleware<
  Params,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> => ({
  provides: ConversationInTask,
  derivePayload: (params: Params) =>
    Effect.succeed({
      taskId: params.taskId,
      conversationId: params.conversationId,
    }),
  obtain: obtainConversationInTask,
});

export const conversationInTaskForSend: CapabilityMiddleware<
  MessagesSendParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<MessagesSendParams>();

export const conversationInTaskForList: CapabilityMiddleware<
  MessagesListParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<MessagesListParams>();

// The four app-principal `task/conversation/*` admin RPCs share the
// IDENTICAL `[ConversationInTask]` capability (D #705 R7 — app-ownership is
// gated separately in the handler body via `assertCallerAppOwnsTask`). The
// derive reads NO principal (pure `taskId`/`conversationId` params), so the
// SAME `conversationInTaskMiddleware<Params>()` typed per the owning method's
// params serves them all.

export const conversationInTaskForArchive: CapabilityMiddleware<
  TaskConversationArchiveParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<TaskConversationArchiveParams>();

export const conversationInTaskForUnarchive: CapabilityMiddleware<
  TaskConversationUnarchiveParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<TaskConversationUnarchiveParams>();

export const conversationInTaskForAddParticipant: CapabilityMiddleware<
  TaskConversationAddParticipantParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<TaskConversationAddParticipantParams>();

export const conversationInTaskForRemoveParticipant: CapabilityMiddleware<
  TaskConversationRemoveParticipantParams,
  typeof ConversationInTask,
  TaskAndConversation,
  MwEnv,
  ConversationInTaskFail
> = conversationInTaskMiddleware<TaskConversationRemoveParticipantParams>();

/**
 * `ContactPolicyAllowsReach` middleware (`task/request` cap[0]). The caller
 * (creator) id is read via `yield* callerAgentId` (principal-as-service —
 * `task/request` is `callablePrincipal: "agent"`); the targets are a typed
 * `params.invitedAgentIds` read. Empty targets provision a no-op proof (the
 * service-layer guards short-circuit on zero targets), preserving the legacy
 * semantics.
 */
export const contactPolicyAllowsReachMiddleware: CapabilityMiddleware<
  TaskRequestParams,
  typeof ContactPolicyAllowsReach,
  CreatorAndTargets,
  MwEnv,
  ContactPolicyAllowsReachFail
> = {
  provides: ContactPolicyAllowsReach,
  derivePayload: (params) =>
    Effect.gen(function* () {
      return {
        creatorAgentId: yield* callerAgentId,
        targetAgentIds: [...params.invitedAgentIds],
      };
    }).pipe(Effect.withSpan("deriveContactPolicyAllowsReach")),
  obtain: obtainContactPolicyAllowsReach,
};

/**
 * `MessageSendPermission` middleware (`messages/send` cap[1]). Reads the
 * caller's id via `yield* callerAgentId`; the rest are typed `params`
 * reads. (The `conversationId`-via-DB-resolution caveat is unchanged —
 * `MessagesSend` declares `conversationId` explicitly in its wire shape,
 * so the typed derive needs no DB lookup here.)
 */
export const messageSendPermissionMiddleware: CapabilityMiddleware<
  MessagesSendParams,
  typeof MessageSendPermission,
  ObtainMessageSendPermissionInput,
  MwEnv,
  MessageSendPermissionFail
> = {
  provides: MessageSendPermission,
  derivePayload: (params) =>
    Effect.gen(function* () {
      return {
        taskId: params.taskId,
        conversationId: params.conversationId,
        senderAgentId: yield* callerAgentId,
        replyToId: params.replyToId,
      };
    }).pipe(Effect.withSpan("deriveMessageSendPermission")),
  obtain: obtainMessageSendPermission,
};
