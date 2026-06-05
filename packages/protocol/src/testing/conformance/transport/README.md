# Conformance — `transport/` layer

Lifecycle-level transport adversity invariants. Lower-level frame
validation, RPC map coverage, and request-id mechanics are handled by
effect/rpc and effect/schema rather than this conformance suite.

## Property files

One file per `register*` registrar. Files are named `<kebab-case-name>.ts`
matching the `register<PascalCase>` exported function.

- `adversity-latency-resilience.ts`
- `adversity-reset-peer-recovery.ts`
- `adversity-timeout-surface.ts`
- `adversity-slow-close-cleanup.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TRANSPORT_PROPERTIES: ReadonlyArray<(ctx: ConformanceRunContext) => void>`
in the order `_shared/suite.ts` invokes them. The aggregator walks the
array; reorder is a behavior change.
