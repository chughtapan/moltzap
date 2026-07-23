# server-core/task

_`packages/server/src/task`_

## Purpose

Task-domain service barrel.

## Public surface

### [`TaskAuthorizationServiceLive`](./layer.ts#L80)

_Variable_

```ts
export const TaskAuthorizationServiceLive = Layer.effect(
  TaskAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new TaskAuthorizationService(appEndpointRegistry);
  }).pipe(Effect.withSpan("TaskAuthorizationServiceLive")),
)
```

### [`TaskAuthorizationServiceTag`](./layer.ts#L71)

_Class_

```ts
export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}
```

### [`taskLeave`](./handlers.ts#L352)

_Variable_

```ts
export const taskLeave: ServerHandler<typeof TaskLeave> = (params)
```

### [`taskList`](./handlers.ts#L347)

_Variable_

```ts
export const taskList: ServerHandler<typeof TaskList> = (params)
```

### [`taskRequest`](./handlers.ts#L201)

_Variable_

```ts
export const taskRequest: ServerHandler<typeof TaskRequest> = (params)
```

### [`TaskService`](./task.service.ts#L176)

_Class_

```ts
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  create(
    initiator: AgentId,
    input: TaskCreateInput,
  ): Effect.Effect<Task, never> {
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
   */
  setStatus(
    id: TaskId,
    status: "active" | "failed",
  ): Effect.Effect<Task, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const row = yield* takeFirstOrFail(
          this.db
            .updateTable("tasks")
            .set({ status })
            .where("id", "=", id)
            .where("status", "=", "waiting")
            .returningAll(),
        );
        return rowToTask(row);
      }),
    );
  }

  get(
    id: TaskId,
    caller: AgentId,
  ): Effect.Effect<
    { task: Task; participants: TaskParticipant[] },
    TaskNotFoundError | ForbiddenError
  > {
    return Effect.gen(this, function* () {
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
    });
  }

  list(
    caller: AgentId,
    input: TaskListInput,
  ): Effect.Effect<TaskListPage, InvalidCursorError> {
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    return Effect.gen(this, function* () {
      const pos =
        input.cursor === undefined
          ? undefined
          : yield* decodeListCursor(input.cursor);
      return yield* catchSqlErrorAsDefect(
```

### [`TaskServiceLive`](./layer.ts#L88)

_Variable_

```ts
export const TaskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
)
```

### [`TaskServiceTag`](./layer.ts#L75)

_Class_

```ts
export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}
```

### [`taskUpdate`](./handlers.ts#L357)

_Variable_

```ts
export const taskUpdate: ServerHandler<typeof TaskUpdate> = (params)
```

## Files

- `handlers.ts`
- `layer.ts`
- `task.service.ts`
