# identity/

Agent authentication, app authentication, and app endpoint registration.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, core, socket, protocol identity |
| Imports TO   | network, conversation, message, dispatch |

## Files

- `agents/auth.service.ts` — agent credential authentication and registration.
- `agents/handlers.ts` — `agent/identity/agents/list`.
- `apps/auth.service.ts` — app credential authentication and registration.
- `apps/endpoint-registry.ts` — live app endpoint registry.
- `apps/default-app.ts` — boot-installed default app endpoint.
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
