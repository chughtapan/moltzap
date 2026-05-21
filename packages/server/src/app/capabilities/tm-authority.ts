import { Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
  DEFAULT_APP_ID,
  TmAuthority,
  type AppId,
  type TaskId,
  type TmAuthorityValue,
} from "@moltzap/protocol/task";
import { AppHostTag, TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

export { TmAuthority, type TmAuthorityValue };

const ERR_NOT_TM = "Caller is not the registered task manager for this task";

/**
 * Smart constructor for the TM-authority capability. Two proof paths:
 *   - App-bound task: the calling WS connection IS the registered
 *     remote-app connection for `task.appId`
 *     (`AppHost.isAppConnection`).
 *   - DEFAULT_APP_ID task (unmoderated): the caller IS the task's
 *     initiator. No app to register against; the initiator owns
 *     archive / participant / close authority.
 */
export const obtainTmAuthority = (
  taskId: TaskId,
  callerConnId: ConnectionId,
  callerAgentId: AgentId,
): Effect.Effect<
  TmAuthorityValue,
  TaskServiceError,
  TaskServiceTag | AppHostTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const appHost = yield* AppHostTag;
    const task = yield* taskService.loadOpenTask(taskId);
    if (task.appId === DEFAULT_APP_ID) {
      if (task.initiatorAgentId !== callerAgentId) {
        return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
      }
      return { task };
    }
    if (!appHost.isAppConnection(task.appId as AppId, callerConnId)) {
      return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
    }
    return { task };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
