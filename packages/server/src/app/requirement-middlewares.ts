/**
 * @file The server-side `obtain` impls for the requirements whose middleware is
 * stacked on a method's engine member (`task-read-access`, `conversation-in-task`,
 * `contact-policy-allows-reach`).
 *
 * Each `obtain` resolves a requirement against server services. The
 * per-requirement `RpcMiddleware` impl Layer (`transport/auth-middleware-layers.ts`)
 * derives the obtain's input from the decoded payload + the caller's agent id and
 * runs it. The send-path obtains (`ConversationSendAccess`,
 * `ActiveTaskPermission`, …) live in `task/services/send-permissions.ts`.
 */
import { Effect } from "effect";
import type {
  AgentId,
  ContactPolicyAllowsReachValue,
} from "@moltzap/protocol/identity";
import type {
  ConversationId,
  ConversationInTaskValue,
} from "@moltzap/protocol/conversation";
import type { TaskId, TaskReadAccessValue } from "@moltzap/protocol/task";
import { ConversationServiceTag, TaskServiceTag } from "./layers.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";

/** Input for {@link obtainTaskReadAccess}. */
export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

/** Input for {@link obtainConversationInTask}. */
export interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

/** Input for {@link obtainContactPolicyAllowsReach}. */
export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/** `TaskReadAccess`: load the task gated on the caller's read access. */
export const obtainTaskReadAccess = (
  input: TaskAndAgent,
): Effect.Effect<TaskReadAccessValue, unknown, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskWithReadAccess(
      input.taskId,
      input.callerAgentId,
    );
    return { task, callerAgentId: input.callerAgentId };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));

/** `ConversationInTask`: prove `conversation.task_id === taskId`. */
export const obtainConversationInTask = (
  input: TaskAndConversation,
): Effect.Effect<ConversationInTaskValue, unknown, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.assertConversationInTask(
      input.taskId,
      input.conversationId,
    );
    return { taskId: input.taskId, conversationId: input.conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));

/** `ContactPolicyAllowsReach`: the creator may reach every target. */
export const obtainContactPolicyAllowsReach = (
  input: CreatorAndTargets,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  unknown,
  ConversationServiceTag
> =>
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
