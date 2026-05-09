# Conformance — `task/` layer

Task / conversation / message invariants. Every property here
exercises `tasks/*`, `conversations/*`, or `messages/*` semantics —
the layer that owns durable state.

## Property files

| File | Carved from |
|---|---|
| `fan-out-cardinality.ts` | `delivery.ts` |
| `store-and-replay.ts` | `delivery.ts` |
| `payload-opacity.ts` | `delivery.ts` |
| `task-boundary-isolation.ts` | `delivery.ts` |
| `conversation-lifecycle.ts` | `delivery.ts` |
| `archive-lifecycle.ts` | `delivery.ts` |
| `task-close-lifecycle.ts` | `delivery.ts` (tombstoned, retombstoned to new follow-up; see plan §5) |
| `model-equivalence.ts` | `rpc-semantics.ts` |

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TASK_PROPERTIES` in the order legacy `_shared/suite.ts` invokes them.

## Tombstone

`task-close-lifecycle` retains its `PropertyDeferred` body. The
`_shared/suite.ts` `allowedServerCoverageGaps` entry preserves the
existing exemption — Phase 1A keeps baseline parity.
