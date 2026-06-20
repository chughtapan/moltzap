# server-core/task/requirements

_`packages/server/src/task/requirements`_

## Purpose

Task-domain requirement helpers.

## Public surface

### [`assertCallerAppOwnsTask`](./app-ownership.ts#L7)

_Function_

```ts
export const assertCallerAppOwnsTask = (appId: AppId, taskId: TaskId)
```

### [`obtainTaskReadAccess`](./read-access.ts#L11)

_Function_

```ts
export const obtainTaskReadAccess = (
  input: TaskAndAgent,
): Effect.Effect<TaskReadAccessValue, unknown, TaskServiceTag>
```

### [`TaskAndAgent`](./read-access.ts#L6)

_Interface_

```ts
export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}
```

## Files

- `app-ownership.ts`
- `read-access.ts`
