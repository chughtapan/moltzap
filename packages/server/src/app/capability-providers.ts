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
 * descriptor's `argsOf(params, ctx)` resolver) and invokes the matching
 * obtain helper from `app/capabilities/*`.
 */
import type { AgentId, ConversationId, TaskId } from "@moltzap/protocol";
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
    const { taskId, callerAgentId } = args as TaskAndAgent;
    return obtainTmAuthority(taskId, callerAgentId);
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
