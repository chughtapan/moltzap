# Conformance — `network/` layer

Connection / presence / subscription invariants. Every property here
exercises `Connect`, `PresenceSubscribe`, or server-derived
`presence/changed` notification semantics — the layer that brokers
who sees whom. (Note: `PresenceUpdate` RPC was deleted in
`2026.527.0`; presence is now server-derived from `LeaseRegistry`
lifecycle. Properties referencing the deleted RPC are impl-staff
scope to rewrite per architect plan #706 v10.)

## Property files

| File | Carved from |
|---|---|
| `presence-connect-broadcast.ts` | `presence.ts` |
| `presence-disconnect-broadcast.ts` | `presence.ts` |
| `presence-reconnect-storm.ts` | `presence.ts` |
| `presence-same-state-no-double-fire.ts` | `presence.ts` |
| `presence-multi-subscriber-fan-out.ts` | `presence.ts` |
| `presence-subscribe-after-connect.ts` | `presence.ts` |

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`NETWORK_PROPERTIES` in the order legacy `_shared/suite.ts` invokes
them.

## Future shape

Connection-level adversity (e.g., subscribe-then-disconnect race,
slow `presence/changed` fan-out under load) lands here when it grows
beyond what the transport-tier `adversity-*` properties cover.
