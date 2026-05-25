# network/

Presence, ping, app-TM registry, agent-endpoint resolution, outbound
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
- `app-tm-registry.ts` — `tm_endpoint_address` → app mapping; seeds
  default DM / Group TMs at boot.
- `network-send.ts` — `NetworkSendService` (the sole outbound
  routing surface; consumes the resolver + connection manager).
- `handlers/ping.handlers.ts` — `network/ping` RPC handler.
- `handlers/presence.handlers.ts` — `presence/*` (routes via TM
  message bus).
- `services/presence.service.ts` — `PresenceService` (online /
  offline / away transitions + subscriber set).
- `services/presence-event-sink.ts` —
  `createConnectionFanOutPresenceEventSink` (the canonical
  fan-out pattern; JSDoc shows the flow).

## Handler shape

```ts
defineNetworkMethod(Ping, {
  handler: () => Effect.succeed({ pong: true }),
});
```

No deps argument. Tags resolved by the dispatcher's `ManagedRuntime`.
