# Conformance — `network/` layer

Connection / presence / subscription invariants. Every property here
exercises `Connect`, `PresenceUpdate`, or `PresenceSubscribe`
semantics — the layer that brokers who sees whom.

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
slow PresenceUpdate fan-out under load) lands here when it grows
beyond what the transport-tier `adversity-*` properties cover.
