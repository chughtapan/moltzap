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
    // `task.appId` arrives as `string` because the wire-shaped TaskSchema
    // still types `appId` as plain string (legacy carry-over from the
    // pre-brand era). Brand at the boundary so the AppHost map lookup
    // is type-safe end-to-end.
    if (!appHost.isAppConnection(task.appId as AppId, callerConnId)) {
      return yield* Effect.fail(new ForbiddenError({ message: ERR_NOT_TM }));
    }
    return { task };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
