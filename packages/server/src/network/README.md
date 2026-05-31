# network/

Presence, ping, agent-endpoint resolution, outbound
`send` and `broadcast`.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels (db, crypto, runtime), transport, identity |
| Imports TO   | task, app |

## Files

- `agent-endpoint-resolver.ts` — `AgentId → HashSet<ConnId>` multimap
  kept fresh by `network/connect` success and the disconnect
  finalizer.
- `network-send.ts` — `NetworkSendService` (the sole outbound
  routing surface; consumes the resolver + connection manager).
- `handlers/ping.handlers.ts` — `network/ping` RPC handler.
- `handlers/presence.handlers.ts` — `presence/subscribe` RPC
  handler. Presence is server-derived from `LeaseRegistry` lifecycle +
  WS connect/disconnect; there is no client-driven `presence/update`.
- `services/presence.service.ts` — `PresenceService`. One service that
  owns the subscriber registry, the lease-derived status engine, and
  the `presence/changed` fan-out. Implements `LeaseTransitionObserver`,
  so `LeaseRegistry` drives lease transitions through it. The fan-out
  sink + dedup helper are module-private (three `@ts-expect-error`
  canaries at `services/presence.service.types-check.ts` assert the
  seal).
- `services/presence-types.ts` — pure helpers + types shared by the
  service and its consumers: `DerivedPresenceStatus`,
  `AgentPresenceEntry`, `deriveEntryStatus`, `emitPresenceTransition`,
  the narrow `LeaseTransitionObserver` contract that `LeaseRegistry`
  depends on, and `noopLeaseTransitionObserver`.

## Handler shape

```ts
defineNetworkMethod(Ping, {
  handler: () => Effect.succeed({ pong: true }),
});
```

No deps argument. Tags resolved by the dispatcher's `ManagedRuntime`.
