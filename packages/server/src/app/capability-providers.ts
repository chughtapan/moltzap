/**
 * @file Capability provider table for `makeServerConnection`.
 *
 * The dispatcher's auto-provision path
 * (`@moltzap/protocol/transport/dispatch.ts → applyCapabilityProvisioning`)
 * keys these callbacks by each `Context.Tag.key` declared on the
 * `RpcDefinition.capabilities` array. Both `makeServerConnection` call
 * sites pass the same constant so the `Caps` generic of
 * `ServerConnectionConfig` agrees across them.
 *
 * Each callback unwraps the dispatcher-supplied `args` (built by the
 * descriptor's `argsOf(params, ctx)` resolver), narrows via a single-
 * level `as` cast, and runs the capability composition inline. The
 * one exception is `MessageSendPermission` — its composition is large
 * enough to live as its own named function next to the services it
 * composes.
 */
import { Effect } from "effect";
import type { AgentId, ConversationId, TaskId } from "@moltzap/protocol";
import {
  ContactPolicyAllowsReach,
  ConversationCreateAuthorization,
  ConversationInTask,
  MessageSendPermission,
  TaskReadAccess,
  TmAuthority,
  type ObtainConversationCreateAuthorizationInput,
  type ObtainMessageSendPermissionInput,
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
  readonly targetAgentIds: ReadonlyArray<AgentId>;
}

export const serverCapabilityProviders = {
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
  [TmAuthority.key]: (args: unknown) => {
    const { taskId, callerAgentId } = args as TaskAndAgent;
    return Effect.gen(function* () {
      const taskService = yield* TaskServiceTag;
      const task = yield* taskService.loadTaskAsTmAuthority(
        taskId,
        callerAgentId,
      );
      return { task, callerAgentId };
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
  [ConversationCreateAuthorization.key]: (args: unknown) => {
    const input = args as ObtainConversationCreateAuthorizationInput;
    return catchSqlErrorAsDefect(
      Effect.gen(function* () {
        const conversations = yield* ConversationServiceTag;
        const ownerByAgentId = yield* conversations.loadAgentOwners(
          input.agentIds,
        );
        yield* conversations.assertContactPolicyForCreate(
          input.creatorAgentId,
          input.agentIds,
          ownerByAgentId,
        );
        yield* conversations.assertGroupCapacityForCreate(input.agentIds);
        return { ownerByAgentId };
      }),
    ).pipe(Effect.withSpan("obtainConversationCreateAuthorization"));
  },
  [MessageSendPermission.key]: (args: unknown) =>
    obtainMessageSendPermission(args as ObtainMessageSendPermissionInput),
} as const;
