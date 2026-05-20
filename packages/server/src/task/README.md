# task/

Conversations, messages, tasks, contacts (handler-routing),
task-manager dispatch.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport, identity, network |
| Imports TO   | app |

## Files

### Handlers
- `handlers/connect.handlers.ts` — `network/connect` post-auth wiring.
- `handlers/conversations.handlers.ts` — legacy `conversations/*`
  RPCs.
- `handlers/messages.handlers.ts` — `messages/send`, `messages/get`,
  `messages/list`.
- `handlers/presence.handlers.ts` — `presence/*` (routes via TM
  message bus).
- `handlers/contacts.handlers.ts` — `contacts/*`.
- `handlers/tasks.handlers.ts` — `tasks/*` legacy family plus the
  Spec D1 singular `task/*` + `task/conversation/*` family.
- `handlers/notification-broadcast.ts` — shared best-effort fan-out
  helper (forks socket writes via `Effect.runFork`).

### Services
- `services/conversation.service.ts` + `conversation-service-types.ts`
  — conversation CRUD, participant membership, archive.
- `services/message.service.ts` + `message-service-types.ts` —
  message insert (`sendInsert` + `sendCommit`), delivery webhook
  fan-out, trace capture wiring.
- `services/task.service.ts` — task lifecycle, the Spec D1
  `TaskConversation*` administrative methods.
- `services/default-tm.ts` — built-in TM that backs default DM /
  Group conversations (no custom moderator).
- `services/conversation-admin-authority.ts` — `assertTmAuthority` /
  `loadTaskAsTmAuthority` gates that obtain helpers consume.

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
