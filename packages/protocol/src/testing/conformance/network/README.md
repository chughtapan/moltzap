# Conformance — `network/` layer

Connection / presence / subscription invariants. The remaining property
exercises the `presence/subscribe` status snapshot. Presence is server-derived
from `LeaseRegistry` lifecycle plus WS connect/disconnect; there is no
client-driven `presence/update` RPC.

## Property files

- `presence-subscribe-after-connect.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`NETWORK_PROPERTIES` in the order `_shared/suite.ts` invokes them.
