# network/

Connect handlers, presence, agent-endpoint resolution, outbound `send` and
`broadcast`.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | db, core, socket, identity |
| Imports TO   | task, conversation, message, dispatch |

## Files

- `agent-endpoint-resolver.ts` — `AgentId → HashSet<ConnId>` multimap
  kept fresh by `agent/network/connect` success and the disconnect
  finalizer.
- `connect.handlers.ts` — agent/app connect RPC handlers.
- `network-send.ts` — `NetworkSendService` (the sole outbound
  routing surface; consumes the resolver + connection manager).
- `presence/handlers.ts` — agent/app presence subscribe RPCs
  handler. Presence is server-derived from `LeaseRegistry` lifecycle +
  WS connect/disconnect; there is no client-driven `presence/update`.
- `presence/presence.service.ts` — `PresenceService`. Owns the
  lease-derived status engine. Implements `LeaseTransitionObserver`, so
  `LeaseRegistry` drives lease transitions through it.
- `presence/presence-types.ts` — pure helpers + types shared by the
  service and its consumers: `DerivedPresenceStatus`,
  `AgentPresenceEntry`, `deriveEntryStatus`, and the narrow
  `LeaseTransitionObserver` contract that `LeaseRegistry` depends on.

## Handler shape

```ts
export const agentPresenceSubscribe: ServerHandler<
  typeof AgentPresenceSubscribe
> = (params) => Effect.gen(function* () {
  const presence = yield* PresenceServiceTag;
  // ...
});
```

No deps argument. Tags are resolved by the socket runtime.
