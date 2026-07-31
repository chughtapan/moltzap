# Conformance — `task/` layer

Task / conversation / message invariants. Every property here
exercises `agent/task/*`, `app|agent/conversation/*`, or `agent/message/*` semantics —
the layer that owns durable state.

## Property files

- `fan-out-cardinality.ts`
- `store-and-replay.ts`
- `payload-opacity.ts`
- `task-boundary-isolation.ts`
- `conversation-lifecycle.ts`
- `task-close-lifecycle.ts`
- `conversation-family.ts` — the `app/conversation/*` family,
  one `register*` per method

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TASK_PROPERTIES` in the order `_shared/suite.ts` invokes them.
