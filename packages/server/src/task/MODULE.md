# server-core/task

_`packages/server/src/task`_

## Purpose

Task-domain service barrel.

## Public surface

### [`taskAuthorizationServiceLive`](./layer.ts#L91)

_Variable_

```ts
export const taskAuthorizationServiceLive = Layer.effect(
  TaskAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new TaskAuthorizationService(appEndpointRegistry);
  }).pipe(Effect.withSpan("TaskAuthorizationServiceLive")),
)
```

Provides the task authorization service live runtime value.

### [`TaskAuthorizationServiceTag`](./layer.ts#L80)

_Class_

```ts
export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}
```

Implements task authorization service tag.

### [`taskLeave`](./handlers.ts#L381)

_Variable_

```ts
export const taskLeave: ServerHandler<typeof taskLeaveDefinition> = Effect.fn(
  "taskLeave",
)(function* (params) {
  return yield* taskLeaveBody(params, yield* agentArm);
})
```

Provides the task leave runtime value.

**Returns:** The task leave result.

### [`taskList`](./handlers.ts#L370)

_Variable_

```ts
export const taskList: ServerHandler<typeof taskListDefinition> = Effect.fn(
  "taskList",
)(function* (params) {
  return yield* taskListBody(params, yield* agentArm);
})
```

Provides the task list runtime value.

**Returns:** The task list result.

### [`taskRequest`](./handlers.ts#L215)

_Variable_

```ts
export const taskRequest: ServerHandler<typeof taskRequestDefinition> =
  Effect.fn("taskRequest")(function* (params) {
    const ctx = yield* agentArm;
    return yield* taskRequestBody(params, ctx);
  })
```

Provides the task request runtime value.

**Returns:** The task leave body result.

### [`TaskService`](./task.service.ts#L188)

_Class_

```ts
export class TaskService {
  private readonly db: Db;
  private readonly conversations: ConversationService;
  private readonly messages: MessageService;

  constructor(
    db: Db,
    conversations: ConversationService,
    messages: MessageService,
  ) {
    this.db = db;
    this.conversations = conversations;
    this.messages = messages;
  }

  create(initiator: AgentId, input: TaskCreateInput): Effect.Effect<Task> {
    return catchSqlErrorAsDefect(
      transaction(this.db, (trx) =>
        Effect.gen(function* () {
          const row = yield* takeFirstOrFail(
            trx
              .insertInto("tasks")
              .values({
                app_id: input.appId,
                initiator_agent_id: initiator,
                status: "waiting",
              })
              .returningAll(),
          );
          // Auto-admit every invited participant at create time. Read
          // paths (`loadTaskWithReadAccess`,
          // `assertAgentInTaskParticipants`, task list scope) gate on
          // `WHERE admitted_at IS NOT NULL`, so a row written with
          // `admitted_at: null` is a pending invite that grants no read
          // access until admitted.
          const admittedAt = new Date();
          yield* trx.insertInto("task_participants").values({
            task_id: row.id,
            agent_id: initiator,
            admitted_at: admittedAt,
          });
          const invited = input.invitedAgentIds ?? [];
          for (const agentId of invited) {
            yield* trx
              .insertInto("task_participants")
              .values({
                task_id: row.id,
                agent_id: agentId,
                admitted_at: admittedAt,
              })
              .onConflict((oc) => oc.doNothing());
          }
          return rowToTask(row);
        }),
      ),
    );
  }

  /**
   * Transition a task from `waiting` to `active` or `failed`. The state
   * machine is `waiting → active | failed`, one-way.
   *
   * The `WHERE status = 'waiting'` guard SQL-enforces the one-way
   * invariant: an UPDATE against an already-transitioned task matches
   * zero rows and `takeFirstOrFail` raises (caught as a defect),
   * rather than silently re-writing a terminal `active`/`failed`/
   * `closed` row. The single guarded UPDATE also means a racing read
   * never observes a stale `waiting` row after the verdict resolves.
   *
   * Returns the updated row so the handler can fan out
   * `agent/task/created { task }` or `task/failed { taskId, reason }`
   * without a second SELECT.
   * @param id Value supplied to the operation.
   * @param status Value supplied to the operation.
   * @returns The row result.
   */
  setStatus(id: TaskId, status: "active" | "failed"): Effect.Effect<Task> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: TaskService) {
          const row = yield* takeFirstOrFail(
            this.db
              .updateTable("tasks")
              .set({ status })
              .where("id", "=", id)
              .where("status", "=", "waiting")
              .returningAll(),
          );
          return rowToTask(row);
        }.bind(this),
      ),
    );
  }

  get(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<
    { task: Task; participants: TaskParticipant[] },
    TaskNotFoundError | ForbiddenError
  > {
    return Effect.gen(
      function* (this: TaskService) {
        const task = yield* this.loadTaskWithReadAccess(id, caller);
        const rows = yield* catchSqlErrorAsDefect(
          this.db
            .selectFrom("task_participants")
            .selectAll()
            .where("task_id", "=", id),
        );
        return {
          task,
          participants: rows.map(rowToParticipant),
        };
      }.bind(this),
    );
  }

  list(caller: AgentId, input: TaskListInput): TaskListEffect {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
```

Implements task service.

### [`taskServiceLive`](./layer.ts#L100)

_Variable_

```ts
export const taskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
)
```

Provides the task service live runtime value.

### [`TaskServiceTag`](./layer.ts#L85)

_Class_

```ts
export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}
```

Implements task service tag.

### [`taskUpdate`](./handlers.ts#L392)

_Variable_

```ts
export const taskUpdate: ServerHandler<typeof taskUpdateDefinition> = Effect.fn(
  "taskUpdate",
)(function* (params) {
  return yield* taskUpdateBody(params, yield* appArm);
})
```

Provides the task update runtime value.

**Returns:** The task update result.

## Files

- `handlers.ts`
- `layer.ts`
- `task.service.ts`
