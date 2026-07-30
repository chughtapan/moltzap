# protocol/task/requirements

_`packages/protocol/src/task/requirements`_

## Purpose

Public barrel for task requirement middleware tags.

Each tag is both the descriptor requirement and the `@effect/rpc` middleware
tag the server implements. The `obtain*` impls that resolve a permission
against server-side services live in `@moltzap/server-core`.

## Public surface

### [`assertAppOwnsTask`](./assert-requirement-matches-task.ts#L43)

_Function_

```ts
export const assertAppOwnsTask = (
  appId: AppId,
  task: Task,
): Effect.Effect<void, ForbiddenError>
```

App-principal ownership gate. App task and conversation mutation handlers
load the open task and call this before the service mutation.

`task.appId` rides as a wire `string`; the brand boundary is the type
system, so the equality check compares the branded `appId` argument to
the row value directly. Fails with `ForbiddenError` (wire -32001) when
the app does not own the task.

**Returns:** The assert app owns task result.

### [`assertTaskReadAccessMatchesTask`](./assert-requirement-matches-task.ts#L17)

_Function_

```ts
export const assertTaskReadAccessMatchesTask = (
  requirement: TaskReadAccessValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError>
```

Verifies `requirement.task.id === expectedTaskId` for `TaskReadAccess`.
One-line guard at the start of every service method that consumes the
requirement plus a separate `taskId` handler-input — catches the "handler
obtained requirement for task A but passed task B" bug for one comparison.

**Returns:** The assert task read access matches task result.

### [`TaskReadAccess`](./task-read-access.ts#L23)

_Class_

```ts
export class TaskReadAccess extends RpcMiddleware.Tag<TaskReadAccess>()(
  "@moltzap/protocol/TaskReadAccess",
  // Fails closed as not-found so the obtain does not leak task existence to a
  // caller without read access.
  { failure: Schema.Union(TaskNotFoundError) },
) {}
```

Implements task read access.

### [`TaskReadAccessValue`](./task-read-access.ts#L17)

_Interface_

```ts
export interface TaskReadAccessValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}
```

Requirement: caller has read access to `task` (initiator OR
admitted `task_participant`).

Value payload carries the `task` row already fetched by the
`TaskService.loadTaskWithReadAccess` check; consumers reuse the payload.

The server middleware implementation resolves the value once and provides it
to handlers through the `@effect/rpc` middleware context.

## Files

- `assert-requirement-matches-task.ts`
- `task-read-access.ts`
