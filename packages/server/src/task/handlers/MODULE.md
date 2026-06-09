# server-core/task/handlers

_`packages/server/src/task/handlers`_

## Purpose

Task-domain handler barrel.

## Public surface

### [`taskAddParticipant`](./tasks.handlers.ts#L164)

_Variable_

```ts
export const taskAddParticipant: ServerHandler<typeof TaskAddParticipant> = (
  params,
)
```

### [`taskClose`](./tasks.handlers.ts#L159)

_Variable_

```ts
export const taskClose: ServerHandler<typeof TaskClose> = (params)
```

### [`taskLeave`](./tasks.handlers.ts#L154)

_Variable_

```ts
export const taskLeave: ServerHandler<typeof TaskLeave> = (params)
```

### [`taskList`](./tasks.handlers.ts#L149)

_Variable_

```ts
export const taskList: ServerHandler<typeof TaskList> = (params)
```

### [`taskRemoveParticipant`](./tasks.handlers.ts#L171)

_Variable_

```ts
export const taskRemoveParticipant: ServerHandler<
  typeof TaskRemoveParticipant
> = (params)
```

### [`taskRequest`](./task-request.handlers.ts#L191)

_Variable_

```ts
export const taskRequest: ServerHandler<typeof TaskRequest> = (params)
```

## Files

- `task-request.handlers.ts`
- `tasks.handlers.ts`
