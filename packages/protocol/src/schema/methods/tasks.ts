import { Type } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { TaskId, TaskSchema, TaskStatusEnum } from "../task.js";
import { defineRpc } from "../../rpc.js";

/**
 * `tasks/create` — replaces `apps/create`. Creates a new task for
 * an app manifest. Result wraps the task record under `task` (was
 * `session`).
 */
export const TasksCreate = defineRpc({
  name: "tasks/create",
  params: Type.Object(
    {
      appId: Type.String(),
      invitedAgentIds: Type.Array(AgentId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

/**
 * `tasks/close` — replaces `apps/closeSession`. Closes a task by id.
 */
export const TasksClose = defineRpc({
  name: "tasks/close",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object(
    { closed: Type.Boolean() },
    { additionalProperties: false },
  ),
});

/**
 * `tasks/get` — replaces `apps/getSession`. Fetches a task by id.
 */
export const TasksGet = defineRpc({
  name: "tasks/get",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

/**
 * `tasks/list` — replaces `apps/listSessions`. Filters by `appId` and
 * `status`. Result key is `tasks` (was `sessions`).
 */
export const TasksList = defineRpc({
  name: "tasks/list",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      status: Type.Optional(TaskStatusEnum),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { tasks: Type.Array(TaskSchema) },
    { additionalProperties: false },
  ),
});

/**
 * `permissions/grant` re-shape — `sessionId` replaced by `taskId`. Keeps
 * agent / resource / access payload unchanged.
 */
export const PermissionsGrant = defineRpc({
  name: "permissions/grant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
      resource: Type.String(),
      access: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});
