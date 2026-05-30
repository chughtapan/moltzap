/**
 * `task/request` handler — agent-initiated task creation that
 * brokers a TM-callback gate via `task/create` before the task
 * transitions out of `waiting`.
 *
 * Lives in the **app layer** (bound via `defineAppMethod`) rather
 * than the task layer because the handler needs `AppHostTag` to
 * fire the `task/create` callback over the bound TM's connection.
 * The descriptor itself stays in `@moltzap/protocol/task` — the
 * wire shape is task-domain; only the dispatch layer changes.
 *
 * Lifecycle (one-way, fail-closed):
 *   1. Validate contact policy + create the task row in `waiting`.
 *   2. Fire `task/create` callback to the bound TM via AppHost.
 *      Timeout / RPC error / decode failure synthesizes a reject
 *      verdict with a synthesized reason code.
 *   3. On `accept` → setStatus(active), fan out `task/created` to
 *      caller + invitees, optionally mint the initialConversation,
 *      return `{ task, conversation }`.
 *   4. On `reject` → setStatus(failed), fan out `task/failed` with
 *      reason, fail the RPC with `TaskRejectedError`.
 */
import { Effect } from "effect";
import {
  TaskConversationCreatedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskRejectedError,
  TaskRequest,
  type AppId,
  type Conversation,
  type Task,
} from "@moltzap/protocol";
import {
  ContactPolicyAllowsReach,
  ConversationCreateAuthorization,
  type TaskId,
} from "@moltzap/protocol/task";
import type { AgentId } from "../types.js";
import {
  AppHostTag,
  ConversationServiceTag,
  TaskServiceTag,
} from "../layers.js";
import { obtainConversationCreateAuthorization } from "../../task/services/conversation-create-authorization.js";
import { broadcastNotificationToAgents } from "../../task/handlers/notification-broadcast.js";
import { defineAppMethod } from "../../transport/define-layered-method.js";
import type { RpcMethodRegistry } from "../../transport/context.js";

type TaskRequestParams = {
  readonly appId: AppId;
  readonly invitedAgentIds: ReadonlyArray<AgentId>;
  readonly initialConversation?: {
    readonly name?: string;
    readonly participants?: ReadonlyArray<AgentId>;
  };
};

type TaskRequestCtx = { readonly agentId: AgentId };

interface MintInitialInput {
  readonly task: Task;
  readonly initial: {
    readonly name?: string;
    readonly participants?: ReadonlyArray<AgentId>;
  };
  readonly invitedAgentIds: ReadonlyArray<AgentId>;
  readonly callerAgentId: AgentId;
}

function mintInitialConversation(input: MintInitialInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const participantAgentIds: ReadonlyArray<AgentId> =
      input.initial.participants ?? input.invitedAgentIds;
    const conversation = yield* conversationService
      .create({
        name: input.initial.name,
        agentIds: [...participantAgentIds],
        creatorAgentId: input.callerAgentId,
        mintTask: Effect.succeed({ id: input.task.id }),
      })
      .pipe(
        Effect.provideServiceEffect(
          ConversationCreateAuthorization,
          obtainConversationCreateAuthorization({
            agentIds: [...participantAgentIds],
            creatorAgentId: input.callerAgentId,
          }),
        ),
      );
    const recipientAgentIds: AgentId[] = [
      input.callerAgentId,
      ...participantAgentIds,
    ];
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      TaskConversationCreatedNotificationDefinition,
      {
        taskId: input.task.id,
        conversationId: conversation.id,
        name: input.initial.name,
        participants: [...participantAgentIds],
      },
    );
    return { task: input.task, conversation };
  }).pipe(Effect.withSpan("task.request.mintInitialConversation"));
}

// Strip `undefined` optionals so the wire schema's
// `additionalProperties: false` doesn't reject an explicit-undefined.
function initialConversationForWire(params: TaskRequestParams) {
  const initial = params.initialConversation;
  if (initial === undefined) return undefined;
  return {
    ...(initial.name !== undefined ? { name: initial.name } : {}),
    ...(initial.participants !== undefined
      ? { participants: [...initial.participants] }
      : {}),
  };
}

// reject verdict → waiting → failed, fan out task/failed, fail the RPC.
function handleReject(
  taskId: TaskId,
  recipients: AgentId[],
  reason: string | undefined,
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const failedTask = yield* taskService.setStatus(taskId, "failed");
    const reasonField: { reason: string } | Record<string, never> =
      reason !== undefined ? { reason } : {};
    yield* broadcastNotificationToAgents(
      recipients,
      TaskFailedNotificationDefinition,
      { taskId: failedTask.id, ...reasonField },
    );
    // `reason` rides in the wire error's `data` arm (RpcErrorPayload),
    // so the requester can read why without parsing the message.
    return yield* Effect.fail(
      new TaskRejectedError({
        data: { taskId: failedTask.id as string, ...reasonField },
      }),
    );
  }).pipe(Effect.withSpan("task.request.reject"));
}

// accept verdict → waiting → active, fan out task/created, then mint
// the initialConversation hint if present.
function handleAccept(
  waitingTaskId: TaskId,
  params: TaskRequestParams,
  ctx: TaskRequestCtx,
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const activeTask = yield* taskService.setStatus(waitingTaskId, "active");
    yield* broadcastNotificationToAgents(
      [ctx.agentId, ...params.invitedAgentIds],
      TaskCreatedNotificationDefinition,
      { task: activeTask },
    );
    if (params.initialConversation === undefined) {
      return { task: activeTask, conversation: null as Conversation | null };
    }
    return yield* mintInitialConversation({
      task: activeTask,
      initial: params.initialConversation,
      invitedAgentIds: params.invitedAgentIds,
      callerAgentId: ctx.agentId,
    });
  }).pipe(Effect.withSpan("task.request.accept"));
}

function taskRequestBody(params: TaskRequestParams, ctx: TaskRequestCtx) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const appHost = yield* AppHostTag;
    // Contact-policy gate. The dispatcher auto-provisions
    // `ContactPolicyAllowsReach` from the descriptor's `capabilities`
    // array before this body runs; draining the tag here makes the
    // gate a precondition of `taskService.create`. Empty
    // `invitedAgentIds` provisions a no-op proof: the service-layer
    // guards short-circuit on zero targets (`loadAgentOwners([])` does
    // no DB work; `assertContactPolicyForCreate(_, [], _)` returns
    // `Effect.void`).
    yield* ContactPolicyAllowsReach;
    const waitingTask = yield* taskService.create(ctx.agentId, {
      appId: params.appId,
      invitedAgentIds: params.invitedAgentIds,
    });
    const initial = initialConversationForWire(params);
    const verdict = yield* appHost.runTaskCreate(params.appId, {
      taskId: waitingTask.id,
      initiatorAgentId: ctx.agentId,
      invitedAgentIds: [...params.invitedAgentIds],
      ...(initial !== undefined ? { initialConversation: initial } : {}),
    });
    return verdict.decision === "reject"
      ? yield* handleReject(
          waitingTask.id,
          [ctx.agentId, ...params.invitedAgentIds],
          verdict.reason,
        )
      : yield* handleAccept(waitingTask.id, params, ctx);
  }).pipe(Effect.withSpan("task.request"));
}

export const taskRequestHandlers: RpcMethodRegistry = [
  // D #705 #720 — the orthogonality proof site: `task/request` is
  // AGENT-called (reads `ctx.agentId` as `initiatorAgentId`) yet binds via
  // `defineAppMethod` (its body `yield*`s `AppHostTag` to fire the
  // `task/create` callback). `callablePrincipal: "agent"` places it in the
  // agent arm + hands the body an `AgentContext`; `defineAppMethod` admits
  // `AppHostTag` in the R-channel. The two axes are independent.
  defineAppMethod(TaskRequest, {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: (params, ctx) => taskRequestBody(params, ctx),
  }),
];
