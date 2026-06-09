import { Effect } from "effect";
import { assertAppOwnsTask, type AppId } from "@moltzap/protocol/task";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "#core";

export const assertCallerAppOwnsTask = (appId: AppId, taskId: TaskId) =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadOpenTask(taskId);
    yield* assertAppOwnsTask(appId, task);
    return task;
  }).pipe(Effect.withSpan("task.assertCallerAppOwnsTask"));
