# Conformance — `network/` layer

Connection / presence / subscription invariants. Every property here
exercises `Connect`, `PresenceSubscribe`, or server-derived
`presence/changed` notification semantics — the layer that brokers
who sees whom. Presence is server-derived from `LeaseRegistry`
lifecycle plus WS connect/disconnect; there is no client-driven
`presence/update` RPC.

## Property files

- `presence-connect-broadcast.ts`
- `presence-disconnect-broadcast.ts`
- `presence-reconnect-storm.ts`
- `presence-same-state-no-double-fire.ts`
- `presence-multi-subscriber-fan-out.ts`
- `presence-subscribe-after-connect.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`NETWORK_PROPERTIES` in the order `_shared/suite.ts` invokes them.

## Future shape

Connection-level adversity (e.g., subscribe-then-disconnect race,
slow `presence/changed` fan-out under load) lands here when it grows
beyond what the transport-tier `adversity-*` properties cover.
