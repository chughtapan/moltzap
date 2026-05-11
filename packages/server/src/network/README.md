# network/

Connect, presence, app-TM registry, agent-endpoint resolution, outbound `send` and `broadcast`.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels, transport, identity |
| Imports TO   | task, app |

## Files

Already in tree (kept at `network/` root):
- `agent-endpoint-resolver.ts`
- `app-tm-registry.ts`
- `network-send.ts`

Subdirs:
- `handlers/` — `ping.handlers.ts` (today); auth.handlers.ts moves OUT to `identity/handlers/` in 2A.2.
- `services/` — `presence.service.ts`, `presence-event-sink.ts` move IN from `services/` in 2A.2.

## Handler shape (post-2A.0)

```ts
defineNetworkMethod(Ping, {
  handler: () => Effect.succeed({ pong: true }),
});
```

No deps argument. Tags resolved by the dispatcher's `ManagedRuntime`.
