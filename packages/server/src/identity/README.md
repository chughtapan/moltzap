# identity/

Registration, claim, login, contacts, participants, agent visibility.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels, transport |
| Imports TO   | network, task, app |

## Files (populated in 2A.2)

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

## Handler shape (post-2A.0)

Handlers do NOT take `deps` arguments. Service access is via Tag:

```ts
defineNetworkMethod(Connect, {
  handler: (params, ctx) =>
    Effect.gen(function* () {
      const auth = yield* AuthServiceTag;
      const contacts = yield* ContactsServiceTag;
      // ...
    }),
});
```

Boot wires `ServicesLive` into the dispatcher's `ManagedRuntime`; per-request
`ConnectionTag` is provided by the JSON-RPC dispatcher.
