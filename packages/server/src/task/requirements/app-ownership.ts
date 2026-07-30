import { Effect } from "effect";
import type { AppId } from "@moltzap/protocol/identity";
import { assertAppOwnsTask, type TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layer.js";

/**
 * Provides the assert caller app owns task runtime value.
 * @param appId Value supplied to the operation.
 * @param taskId Value supplied to the operation.
 * @returns The assert caller app owns task result.
 */
export const assertCallerAppOwnsTask = (appId: AppId, taskId: TaskId) =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadOpenTask(taskId);
    yield* assertAppOwnsTask(appId, task);
    return task;
  }).pipe(Effect.withSpan("task.assertCallerAppOwnsTask"));
