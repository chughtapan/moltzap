# Conformance — `task/` layer

Task / conversation / message invariants. Every property here
exercises `tasks/*`, `conversations/*`, or `messages/*` semantics —
the layer that owns durable state.

## Property files

- `fan-out-cardinality.ts`
- `store-and-replay.ts`
- `payload-opacity.ts`
- `task-boundary-isolation.ts`
- `conversation-lifecycle.ts`
- `archive-lifecycle.ts`
- `task-close-lifecycle.ts`
- `model-equivalence.ts`
- `task-conversation-family.ts` — the `task/conversation/*` family,
  one `register*` per method

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TASK_PROPERTIES` in the order `_shared/suite.ts` invokes them.
