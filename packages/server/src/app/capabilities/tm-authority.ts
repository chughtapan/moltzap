import { Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import {
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
 * Smart constructor for the TM-authority capability. Proves the calling
 * WS connection IS the registered remote-app connection for
 * `task.appId`. Tasks bound to an app with no registered remote-app
 * connection (e.g. the unmoderated default app) have no TM — TM-only
 * RPCs are unreachable on them by design.
 */
export const obtainTmAuthority = (
  taskId: TaskId,
  callerConnId: ConnectionId,
): Effect.Effect<
  TmAuthorityValue,
  TaskServiceError,
  TaskServiceTag | AppHostTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const appHost = yield* AppHostTag;
    const task = yield* taskService.loadOpenTask(taskId);
    if (!appHost.isAppConnection(task.appId as AppId, callerConnId)) {
      return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
    }
    return { task };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
