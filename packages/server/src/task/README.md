# task/

Conversations, messages, tasks, contacts (handler-routing), task-manager dispatch.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels, transport, identity, network |
| Imports TO   | app |

## Files

Existing:
- `handlers/messages.handlers.ts`
- `handlers/tasks.handlers.ts`

Moved IN during 2A.2:
- `services/conversation.service.ts`
- `services/message.service.ts`
- `services/task.service.ts`
- `services/default-tm.ts`
- `services/conversation-admin-authority.ts`

## Handler shape (post-2A.0)

```ts
defineTaskMethod(MessagesSend, {
  requiresActive: true,
  handler: (params, ctx) =>
    Effect.gen(function* () {
      const messages = yield* MessageServiceTag;
      const conversations = yield* ConversationServiceTag;
      const tasks = yield* TaskServiceTag;
      const db = yield* DbTag;
      const leaseRegistry = yield* LeaseRegistryTag;
      // ... handler body using yield* on each service
    }),
});
```

No `createMessageHandlers({deps})` factory. The handler binding's `R` channel
holds every Tag the body pulls; the dispatcher's `ManagedRuntime` provides them.

See `task/handlers/sample-migrated.ts.example` for a worked migration example.
