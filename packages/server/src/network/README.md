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
- `handlers/presence.handlers.ts` — `presence/subscribe` RPC
  handler. v7 (architect plan #706): `presence/update` deleted;
  presence is server-derived from `LeaseRegistry` lifecycle via
  `PresenceProjection`.
- `services/presence.service.ts` — `PresenceService` (subscriber
  registry only post-v7; status mutation lives in
  `PresenceProjection`).
- `services/presence-projection.ts` + `services/_internal/presence-emit.ts` —
  the architect-plan #706 module group. The projection observes
  `LeaseRegistry` transitions + WS lifecycle hooks and emits
  `presence/changed` via a TS-module-sealed fan-out sink in the
  `_internal/` submodule (three `@ts-expect-error` canaries at
  `services/presence-projection.types-check.ts` assert the seal).

## Handler shape

```ts
defineNetworkMethod(Ping, {
  handler: () => Effect.succeed({ pong: true }),
});
```

No deps argument. Tags resolved by the dispatcher's `ManagedRuntime`.
