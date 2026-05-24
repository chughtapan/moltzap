/**
 * @file Shared capability provider table for `makeServerConnection`.
 *
 * Spec F #632 cutover. The dispatcher's auto-provision path
 * (`@moltzap/protocol/transport/dispatch.ts → applyCapabilityProvisioning`)
 * keys obtain helpers by each `Context.Tag.key` declared on the
 * `RpcDefinition.capabilities` array. Both `makeServerConnection` call
 * sites (per-socket `acquireConnectionRpcClient` + the
 * `socket-handler.ts` factory) pass an IDENTICAL provider table, so we
 * extract it here.
 *
 * Each provider unwraps the dispatcher-supplied `args` (built by the
 * descriptor's `argsOf(params, ctx)` resolver) via a single-level `as`
 * cast and runs the capability composition. The simple obtains live
 * inline here (each has exactly one consumer — this table). The two
 * composites with their own direct consumers live as named functions
 * next to the services they compose: `obtainMessageSendPermission` and
 * `obtainConversationCreateAuthorization` in `task/services/`.
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
