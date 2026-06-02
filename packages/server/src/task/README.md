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
  `app/handlers/task-request.handlers.ts` because its handler binds
  via `defineAppMethod`.
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
defineTaskMethod(MessagesSend, {
  requiresActive: true,
  handler: (params, ctx) =>
    Effect.gen(function* () {
      const messages = yield* MessageServiceTag;
      const conversations = yield* ConversationServiceTag;
      // ...
    }),
});
```

No `createMessageHandlers({deps})` factory. The handler binding's `R`
channel holds every Tag the body pulls; the dispatcher's
`ManagedRuntime` provides them.
