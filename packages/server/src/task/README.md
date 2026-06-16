# task/

Task lifecycle and task-owned RPC handlers.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), socket, identity, network |
| Imports TO   | conversation, message, dispatch, identity/apps |

## Files

### Handlers
- `handlers.ts` — `agent/task/request`, `agent/task/list`,
  `agent/task/leave`, and `app/task/update`.

### Services
- `task.service.ts` — task lifecycle and task participant updates.

### Requirements
- `requirements/read-access.ts` — `TaskReadAccess` obtain.
- `requirements/app-ownership.ts` — app ownership checks for app-owned task
  mutations.

## Handler shape

```ts
export const messagesSend: ServerHandler<typeof MessagesSend> = (params) =>
  Effect.gen(function* () {
    const messages = yield* MessageServiceTag;
    // ...
  });
```

Handlers are collected in `moltzap/handler-catalog.ts`. The handler body's `R`
channel holds every Tag it pulls; the socket runtime provides the services and
per-request `ConnectionTag`.
