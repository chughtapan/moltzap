# identity/

Auth, agents, sessions, participants, contact policy.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport |
| Imports TO   | network, task, app |

## Files

- `services/auth.service.ts` — agent registration, claim, key
  rotation, session validation entry point.
- `services/contact.service.ts` — contact policy lookups for
  conversation create / message admission.
- `services/participant.service.ts` — participant existence +
  membership queries.
- `services/agent-visibility.ts` — visible-agent enumeration.
- `services/agent-auth.ts` — API key + session credential resolution.
- `services/session-validator.ts` — webhook-backed session
  validation (`SessionValidatorTag` provider).
- `handlers/agents-lookup.handlers.ts` — `agents/lookup`,
  `agents/list` RPC handlers.

## Handler shape

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

Boot wires `ServicesLive` into the dispatcher's `ManagedRuntime`;
per-request `ConnIdTag` is provided by the JSON-RPC dispatcher.
