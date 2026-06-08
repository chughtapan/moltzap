# task/

Conversations, messages, tasks, task-manager dispatch.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport, identity, network |
| Imports TO   | app |

## Files

### Handlers
- `handlers/messages.handlers.ts` — `messages/send`, `messages/get`,
  `messages/list`.
- `handlers/tasks.handlers.ts` — `task/*` + `task/conversation/*`
  admin family. `task/request` lives in
  `app/handlers/task-request.handlers.ts` because the handler needs the app
  dispatcher.
- `handlers/notification-broadcast.ts` — shared best-effort fan-out
  helper (forks socket writes via `Effect.runFork`).

### Services
- `services/conversation.service.ts` + `conversation-service-types.ts`
  — conversation CRUD, participant membership, archive.
- `services/message.service.ts` + `message-service-types.ts` —
  message insert (`sendInsert` + `sendCommit`), delivery webhook
  fan-out, trace capture wiring.
- `services/task.service.ts` — task lifecycle plus the
  `TaskConversation*` administrative methods.
- `services/conversation-list-pagination.ts` — shared cursor +
  page-shape helpers consumed by `conversation.service.ts`.

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
