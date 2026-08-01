# Conformance — delivery layer

Conversation / message delivery invariants. Every property here
exercises `agent|app/conversation/*` or `agent/message/*` semantics —
the layer that owns durable state.

## Property files

- `fan-out-cardinality.ts`
- `store-and-replay.ts`
- `payload-opacity.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`DELIVERY_PROPERTIES` in the order `_shared/suite.ts` invokes them.
