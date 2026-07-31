# server-core/task/requirements

_`packages/server/src/task/requirements`_

## Purpose

Task-domain requirement helpers.

## Public surface

### [`assertCallerAppOwnsTask`](./app-ownership.ts#L12)

_Variable_

```ts
export const assertCallerAppOwnsTask = Effect.fn(
  "task.assertCallerAppOwnsTask",
)(function* (appId: AppId, taskId: TaskId) {
  const taskService = yield* TaskServiceTag;
  const task = yield* taskService.loadOpenTask(taskId);
  yield* assertAppOwnsTask(appId, task);
  return task;
})
```

Provides the assert caller app owns task runtime value.

### [`obtainTaskReadAccess`](./read-access.ts#L21)

_Function_

```ts
export const obtainTaskReadAccess = (
  input: TaskAndAgent,
): Effect.Effect<TaskReadAccessValue, TaskNotFoundError, TaskServiceTag>
```

Provides the obtain task read access runtime value.

**Returns:** The obtain task read access result.

### [`TaskAndAgent`](./read-access.ts#L11)

_Interface_

```ts
export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}
```

Describes task and agent.

## Files

- `app-ownership.ts`
- `read-access.ts`
