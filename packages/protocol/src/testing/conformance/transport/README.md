# Conformance — `transport/` layer

Wire-level invariants. Every property here exercises a frame, an RPC
primitive, or a connection-adversity surface that lives below
identity / network / task / app.

## Property files

One file per `register*` registrar. Files are named `<kebab-case-name>.ts`
matching the `register<PascalCase>` exported function.

- `request-well-formedness.ts`
- `notification-well-formedness.ts`
- `round-trip-identity.ts`
- `malformed-frame-handling.ts`
- `rpc-map-coverage.ts`
- `request-id-uniqueness.ts`
- `caller-controlled-app-callback-timeout.ts`
- `adversity-latency-resilience.ts`
- `adversity-slicer-framing.ts`
- `adversity-reset-peer-recovery.ts`
- `adversity-timeout-surface.ts`
- `adversity-slow-close-cleanup.ts`
- `schema-exhaustive-fuzz.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TRANSPORT_PROPERTIES: ReadonlyArray<(ctx: ConformanceRunContext) => void>`
in the order `_shared/suite.ts` invokes them. The aggregator walks the
array; reorder is a behavior change.

## Caller-controlled timeout placement

`caller-controlled-app-callback-timeout` sits in `transport/` rather
than `app/` because the property exercises the caller-side timeout
primitive on `sendRpc` — a transport surface — not the app-callback
semantics it happens to drive. The invariant is about the wire timeout
fired locally, not about app-host behavior.

## Schema exhaustive fuzz placement

`schema-exhaustive-fuzz` lives in `transport/` because schemas ARE
wire artifacts. It happens to span every layer's payloads, but the
invariant under test is "the wire decoder rejects malformed
inputs" — a transport-tier statement.
