import { Effect } from "effect";
import { ForbiddenError } from "@moltzap/protocol";
import {
  TmAuthority,
  type TmAuthorityValue,
  type TaskId,
} from "@moltzap/protocol/task";
import { AppHostTag, TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

export { TmAuthority, type TmAuthorityValue };

const ERR_NOT_TM = "Caller is not the registered task manager for this task";

/**
 * Smart constructor for the TM-authority capability. The proof is
 * "the calling WS connection IS the registered remote-app connection
 * for `task.appId`". Body:
 *   1. Fetch the task (existence + open-status gate via
 *      `TaskService.loadOpenTask`).
 *   2. Check app-ownership of `callerConnId` against `task.appId` via
 *      `AppHost.isAppConnection`.
 *
 * Error channel: `TaskServiceError` (carried verbatim from
 * `loadOpenTask` — typically `ForbiddenError` on closed/failed task or
 * `NotFoundError` on missing task; SqlError is caught defectively
 * inside `fetchTask`) plus a `ForbiddenError` on the auth failure.
 */
export const obtainTmAuthority = (
  taskId: TaskId,
  callerConnId: string,
): Effect.Effect<
  TmAuthorityValue,
  TaskServiceError,
  TaskServiceTag | AppHostTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const appHost = yield* AppHostTag;
    const task = yield* taskService.loadOpenTask(taskId);
    if (!appHost.isAppConnection(task.appId, callerConnId)) {
      return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
    }
    return { task };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
