# task/

Task lifecycle and task-owned RPC handlers.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), socket, identity, network |
| Imports TO   | conversation, message, dispatch, identity/apps |

## Files

### Handlers
- `handlers/tasks.handlers.ts` — `task` + `conversation`
  admin family.
- `handlers/task-request.handlers.ts` — `agent/task/request`, including the
  `app/task/create` app callback.

### Services
- `services/task.service.ts` — task lifecycle plus the
  `Conversation*` administrative methods.

### Requirements
- `requirements/read-access.ts` — `TaskReadAccess` obtain.

## Handler shape

```ts
export const messagesSend: ServerHandler<typeof MessagesSend> = (params) =>
  Effect.gen(function* () {
    const messages = yield* MessageServiceTag;
    // ...
  });
```

Handlers are collected in `core/handler-catalog.ts`. The handler body's `R`
channel holds every Tag it pulls; the socket runtime provides the services and
per-request `ConnectionTag`.
