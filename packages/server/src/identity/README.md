# identity/

Registration, claim, login, contacts, participants, agent visibility.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels, transport |
| Imports TO   | network, task, app |

## Files

- `services/auth.service.ts` (from `services/`)
- `services/contact.service.ts` (from `services/`)
- `services/participant.service.ts` (from `services/`)
- `services/agent-visibility.ts` (from `services/`)
- `services/credential-keys.ts` (from `auth/`)
- `services/contact-policy.ts` — `ContactService` policy contract
  (the cross-user reach predicate `AppHost` asks at runtime).
- `services/webhook-contact-service.ts` — webhook-backed
  `ContactService` (transport: `@effect/platform/HttpClient`).
- `handlers/agents-lookup.handlers.ts` — `agents/lookup`.
- `handlers/connect.handlers.ts` — `agent/connect` and `app/connect` post-auth wiring
  (auth handshake is an identity concern).
- `handlers/contacts.handlers.ts` — `contacts/*`.

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
