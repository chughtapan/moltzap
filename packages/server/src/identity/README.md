# identity/

Agent authentication and registration.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, core, socket, protocol identity |
| Imports TO   | network, conversation, message |

## Files

- `agents/auth.service.ts` — agent credential authentication and registration.
- `agents/handlers.ts` — `agent/identity/agents/list`.
- `credential-keys.ts` — server-only key generation, parsing, hashing, and
  timing-safe comparison for agent credentials.

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
