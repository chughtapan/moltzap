# protocol/task

_`packages/protocol/src/task`_

## Purpose

Public barrel for task protocol descriptors.

## Public surface

### [`agentCallableTaskRpcMethods`](./index.ts#L50)

_Variable_

```ts
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
] as const
```

Task RPC catalog callable by agent clients.

### [`appCallableTaskRpcMethods`](./index.ts#L57)

_Variable_

```ts
export const appCallableTaskRpcMethods = [TaskUpdate] as const
```

Task RPC catalog callable by app clients.

### [`HookBlockedError`](./tasks.ts#L84)

_Class_

```ts
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}
```

### [`InitialConversationInput`](./tasks.ts#L157)

_TypeAlias_

```ts
export type InitialConversationInput = Schema.Schema.Type<
  typeof InitialConversationSchema
>;
```

### [`Task`](./tasks.ts#L106)

_TypeAlias_

```ts
export type Task = Schema.Schema.Type<typeof TaskSchema>;
```

### [`taskCallbackMethods`](./index.ts#L60)

_Variable_

```ts
export const taskCallbackMethods = [TaskCreate] as const
```

Task callback catalog served by app clients for server-initiated calls.

### [`TaskClosedError`](./tasks.ts#L61)

_Class_

```ts
export class TaskClosedError extends Schema.TaggedError<TaskClosedError>()(
  "TaskClosed",
  errorPayloadFields,
) {
  static readonly message = "Task is closed";
}
```

### [`TaskClosedNotificationDefinition`](./tasks.ts#L369)

_Variable_

```ts
export const TaskClosedNotificationDefinition = defineNotification({
  name: "agent/task/closed",
  params: TaskClosedNotificationSchema,
})
```

Pushed when a task closes.

### [`TaskCreate`](./tasks.ts#L238)

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

### [`TaskCreatedNotificationDefinition`](./tasks.ts#L360)

_Variable_

```ts
export const TaskCreatedNotificationDefinition = defineNotification({
  name: "agent/task/created",
  params: TaskCreatedNotificationSchema,
})
```

Pushed to the task initiator + invited participants after the TM accepts via
the `app/task/create` wire callback and the task transitions from `waiting`
to `active`. Carries the full Task row (matching `agent/task/closed`'s shape) so
subscribers don't need a second read to discover the post-transition state.

### [`TaskFailedNotificationDefinition`](./tasks.ts#L349)

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

### [`TaskLeave`](./tasks.ts#L263)

_Variable_

```ts
export const TaskLeave = defineRpc({
  name: "agent/task/leave",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({}),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [TaskNotFoundError],
})
```

Self-only: caller removes themselves from `task_participants` AND
every `conversation_participants` row under the task.

Notification emission for each conversation the caller leaves uses
`TaskConversationParticipantsRemovedNotificationDefinition` with
`reason: "task_leave"`. If removal empties `task_participants` the task
transitions to `status = 'closed'` and `TaskClosedNotificationDefinition`
fires alongside in the same transaction.

- **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).

### [`TaskList`](./tasks.ts#L132)

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

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`TaskNotFoundError`](./ids.ts#L15)

_Class_

```ts
export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFound",
  {
    message: Schema.optional(Schema.String),
    data: Schema.optional(Schema.Unknown),
  },
) {
  static readonly message = "Task not found";
}
```

The referenced task does not exist (or the caller cannot see it). Lives in the
task-id leaf so the `TaskReadAccess` requirement can declare it as its
fail-closed not-found without a `requirements -> tasks` runtime import cycle.

### [`taskNotifications`](./index.ts#L63)

_Variable_

```ts
export const taskNotifications = [
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const
```

Task notification catalog emitted by the server.

### [`TaskParticipant`](./tasks.ts#L120)

_TypeAlias_

```ts
export type TaskParticipant = Schema.Schema.Type<typeof TaskParticipantSchema>;
```

### [`TaskRejectedError`](./tasks.ts#L77)

_Class_

```ts
export class TaskRejectedError extends Schema.TaggedError<TaskRejectedError>()(
  "TaskRejected",
  errorPayloadFields,
) {
  static readonly message = "Task request was rejected by the task manager";
}
```

`agent/task/request` failed because the bound TM rejected the
server-initiated `app/task/create` callback (or the fail-closed
envelope synthesized a reject on timeout / RPC error / decode
failure). The tag lets a requester distinguish "my task was
rejected by the moderator" — an expected, actionable outcome —
from an opaque internal error. The TM's reason rides in the
`data` arm when present.

### [`TaskRequest`](./tasks.ts#L184)

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
  requires: [AgentPrincipal, AgentClaimed, ContactPolicyAllowsReach],
  errors: [TaskRejectedError, AgentNotFoundError, ConversationFullError],
})
```

Open to any claimed agent. Returns `{ task, conversation }` where
`conversation` is `null` when `initialConversation` is omitted.

Dedup is a client-side concern: clients that want "one DM per
participant set" semantics list their tasks and filter locally
before creating a new one.

The agent-facing entry RPC is `agent/task/request`; the app-facing wire
callback `app/task/create` lives in this task domain. The server
forks `app/task/create` to the bound TM after inserting the task in
`waiting`; the TM's verdict drives the lifecycle (accept → active +
`agent/task/created`; reject → failed + `agent/task/failed`). The
synchronous `{ task, conversation }`
result is returned after the verdict resolves (the handler awaits it).

- **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).
- **Requirements (run order):** `ContactPolicyAllowsReach` proves the caller may
  reach every `invitedAgentIds` target under the recipient's contact policy.

### [`TaskStatus`](./tasks.ts#L94)

_TypeAlias_

```ts
export type TaskStatus = Schema.Schema.Type<typeof TaskStatusEnum>;
```

### [`TaskUpdate`](./tasks.ts#L318)

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

TM-only task mutation surface. `app/task/update` owns task close,
participant admit, and participant remove semantics.

- **Principal:** `AppPrincipal` head. The app-arm handler runs
  `assertCallerAppOwnsTask` before dispatching the selected action.

### [`TaskUpdateParams`](./tasks.ts#L302)

_TypeAlias_

```ts
export type TaskUpdateParams = Schema.Schema.Type<
  typeof TaskUpdateParamsSchema
>;
```

### [`TaskUpdateResult`](./tasks.ts#L305)

_TypeAlias_

```ts
export type TaskUpdateResult = Schema.Schema.Type<
  typeof TaskUpdateResultSchema
>;
```

## Files

- `ids.ts`
- `index.ts`
- `tasks.ts`
