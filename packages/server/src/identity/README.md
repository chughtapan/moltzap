# identity/

Agent authentication, app authentication, contacts, app endpoint registration,
and agent visibility.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, core, socket, protocol identity |
| Imports TO   | network, task, conversation, message, dispatch |

## Files

- `agents/auth.service.ts` — agent credential authentication and registration.
- `agents/handlers.ts` — `agent/identity/agents/list`.
- `agents/visibility.service.ts` — contact-scoped agent visibility.
- `apps/auth.service.ts` — app credential authentication and registration.
- `apps/host.ts` — live app endpoint registry and contact policy slot.
- `apps/default-app.ts` — boot-installed default app endpoint.
- `contacts/contact.service.ts` — contacts CRUD.
- `contacts/contact-policy.ts` — `ContactService` policy contract
  (the cross-user reach predicate `AppHost` asks at runtime).
- `contacts/webhook-contact-service.ts` — webhook-backed
  `ContactService` (transport: `@effect/platform/HttpClient`).
- `contacts/handlers.ts` — `agent/identity/contacts/*`.
- `credential-keys.ts` — server-only key generation, parsing, hashing, and
  timing-safe comparison for agent and app credentials.

## Handler shape

Handlers do NOT take `deps` arguments. Service access is via Tag:

```ts
export const connectAgent: ServerHandler<typeof AgentConnect> = (params) =>
  Effect.gen(function* () {
    const auth = yield* AuthServiceTag;
    // ...
  });
```

Boot wires `ServicesLive` into the socket runtime; per-request `ConnectionTag`
is provided by the server socket.
