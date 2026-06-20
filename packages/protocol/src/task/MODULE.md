# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task protocol descriptors.

## Public surface

### [`agentCallableTaskRpcMethods`](./tasks.ts#L369)

_Variable_

```ts
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
] as const
```

Task RPC catalog callable by agent clients.

### [`appCallableTaskRpcMethods`](./tasks.ts#L376)

_Variable_

```ts
export const appCallableTaskRpcMethods = [TaskUpdate] as const
```

Task RPC catalog callable by app clients.

### [`HookBlockedError`](./tasks.ts#L78)

_Class_

```ts
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L151)

_TypeAlias_

```ts
export type InitialConversationInput = Schema.Schema.Type<
  typeof InitialConversationSchema
>;
```

### [`Task`](./tasks.ts#L100)

_TypeAlias_

```ts
export type Task = Schema.Schema.Type<typeof TaskSchema>;
```

### [`taskCallbackMethods`](./tasks.ts#L379)

_Variable_

```ts
export const taskCallbackMethods = [TaskCreate] as const
```

Task callback catalog served by app clients for server-initiated calls.

### [`TaskClosedError`](./tasks.ts#L55)

_Class_

```ts
export class TaskClosedError extends Schema.TaggedError<TaskClosedError>()(
  "TaskClosed",
  errorPayloadFields,
) {
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L363)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification({
  name: "agent/task/closed",
  params: TaskClosedNotificationSchema,
})
```

Pushed when a task closes.

### [`TaskCreate`](./tasks.ts#L232)

_Variable_

```ts
export const TaskCreate = defineRpc({
  name: "app/task/create",
  params: TaskCreateContextSchema,
  result: Schema.Struct({ verdict: TaskCreateVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
})
```

Server → app round-trip asking whether the app accepts a newly requested
task.

- **Principal:** none — a server→client reverse callback.

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L354)

_Variable_

```ts
export const TaskCreatedNotificationDefinition = defineNotification({
  name: "agent/task/created",
  params: TaskCreatedNotificationSchema,
})
```

Pushed to the task initiator + invited participants after the app accepts via
the `app/task/create` wire callback and the task transitions from `waiting`
to `active`. Carries the full Task row (matching `agent/task/closed`'s shape) so
subscribers don't need a second read to discover the post-transition state.

### [`TaskFailedNotificationDefinition`](./tasks.ts#L343)

_Variable_

```ts
export const TaskFailedNotificationDefinition = defineNotification({
  name: "agent/task/failed",
  params: TaskFailedNotificationSchema,
})
```

Pushed when a task fails before becoming ready.

### [`TaskId`](./ids.ts#L4)

_TypeAlias_

```ts
export type TaskId = string & Brand.Brand<"TaskId">;
```

### [`TaskId`](./ids.ts#L4)

_Variable_

```ts
export type TaskId = string & Brand.Brand<"TaskId">
```

### [`TaskLeave`](./tasks.ts#L257)

_Variable_

```ts
export const TaskLeave = defineRpc({
  name: "agent/task/leave",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({}),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [TaskNotFoundError],
})
```

Self-only: caller removes themselves from `task_participants` AND
every `conversation_participants` row under the task.

Notification emission for each conversation the caller leaves uses
`ConversationParticipantsRemovedNotificationDefinition` with
`reason: "task_leave"`. If removal empties `task_participants` the task
transitions to `status = 'closed'` and `TaskClosedNotificationDefinition`
fires alongside in the same transaction.

- **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).

### [`TaskList`](./tasks.ts#L126)

_Variable_

```ts
export const TaskList = defineRpc({
  name: "agent/task/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    tasks: Schema.Array(TaskSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError],
})
```

List the caller's own tasks, cursor-paginated.

- **Principal:** `AgentPrincipal` head.

### [`TaskNotFoundError`](./ids.ts#L15)

_Class_

```ts
export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFound",
  errorPayloadFields,
) {
  static readonly message = "Task not found";
}
```

The referenced task does not exist (or the caller cannot see it). Lives in the
task-id leaf so the `TaskReadAccess` requirement can declare it as its
fail-closed not-found without a `requirements -> tasks` runtime import cycle.

### [`taskNotifications`](./tasks.ts#L382)

_Variable_

```ts
export const taskNotifications = [
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const
```

Task notification catalog emitted by the server.

### [`TaskParticipant`](./tasks.ts#L114)

_TypeAlias_

```ts
export type TaskParticipant = Schema.Schema.Type<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L71)

_Class_

```ts
export class TaskRejectedError extends Schema.TaggedError<TaskRejectedError>()(
  "TaskRejected",
  errorPayloadFields,
) {
  static readonly message = "Task request was rejected by the owning app";
}
```

`agent/task/request` failed because the owning app rejected the
server-initiated `app/task/create` callback (or the fail-closed
envelope synthesized a reject on timeout / RPC error / decode
failure). The tag lets a requester distinguish "my task was
rejected by the moderator" — an expected, actionable outcome —
from an opaque internal error. The app's reason rides in the
`data` arm when present.

### [`TaskRequest`](./tasks.ts#L178)

_Variable_

```ts
export const TaskRequest = defineRpc({
  name: "agent/task/request",
  params: Schema.Struct({
    appId: AppId,
    invitedAgentIds: Schema.Array(AgentId),
    initialConversation: Schema.optional(InitialConversationSchema),
  }),
  result: Schema.Struct({
    task: TaskSchema,
    conversation: Schema.Union(ConversationSchema, Schema.Null),
  }),
  requires: [AgentPrincipal, ActiveAgent, ContactPolicyAllowsReach],
  errors: [TaskRejectedError, AgentNotFoundError, ConversationFullError],
})
```

Open to any active agent. Returns `{ task, conversation }` where
`conversation` is `null` when `initialConversation` is omitted.

Dedup is a client-side concern: clients that want "one DM per
participant set" semantics list their tasks and filter locally
before creating a new one.

The agent-facing entry RPC is `agent/task/request`; the app-facing wire
callback `app/task/create` lives in this task domain. The server
forks `app/task/create` to the owning app after inserting the task in
`waiting`; the app verdict drives the lifecycle (accept → active +
`agent/task/created`; reject → failed + `agent/task/failed`). The
synchronous `{ task, conversation }`
result is returned after the verdict resolves (the handler awaits it).

- **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).
- **Requirements (run order):** `ContactPolicyAllowsReach` proves the caller may
  reach every `invitedAgentIds` target under the recipient's contact policy.

### [`TaskStatus`](./tasks.ts#L88)

_TypeAlias_

```ts
export type TaskStatus = Schema.Schema.Type<typeof TaskStatusEnum>;
```

### [`TaskUpdate`](./tasks.ts#L312)

_Variable_

```ts
export const TaskUpdate = defineRpc({
  name: "app/task/update",
  params: TaskUpdateParamsSchema,
  result: TaskUpdateResultSchema,
  requires: [AppPrincipal],
  errors: [ForbiddenError, TaskNotFoundError],
})
```

App-only task mutation surface. `app/task/update` owns task close,
participant admit, and participant remove semantics.

- **Principal:** `AppPrincipal` head. The app-arm handler runs
  `assertCallerAppOwnsTask` before dispatching the selected action.

### [`TaskUpdateParams`](./tasks.ts#L296)

_TypeAlias_

```ts
export type TaskUpdateParams = Schema.Schema.Type<
  typeof TaskUpdateParamsSchema
>;
```

### [`TaskUpdateResult`](./tasks.ts#L299)

_TypeAlias_

```ts
export type TaskUpdateResult = Schema.Schema.Type<
  typeof TaskUpdateResultSchema
>;
```

## Files

- `ids.ts`
- `tasks.ts`
