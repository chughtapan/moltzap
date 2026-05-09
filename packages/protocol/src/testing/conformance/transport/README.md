# Conformance — `transport/` layer

Wire-level invariants. Every property here exercises a frame, an RPC
primitive, or a connection-adversity surface that lives below
identity / network / task / app.

## Property files

One file per `register*` registrar. Files are named `<kebab-case-name>.ts`
matching the legacy `register<PascalCase>` exported function.

Carved from legacy monoliths in Phase 1A:

| File | Carved from |
|---|---|
| `request-well-formedness.ts` | `schema-conformance.ts` |
| `notification-well-formedness.ts` | `schema-conformance.ts` |
| `round-trip-identity.ts` | `schema-conformance.ts` |
| `malformed-frame-handling.ts` | `schema-conformance.ts` |
| `rpc-map-coverage.ts` | `schema-conformance.ts` |
| `request-id-uniqueness.ts` | `rpc-semantics.ts` |
| `caller-controlled-app-callback-timeout.ts` | `rpc-semantics.ts` |
| `adversity-latency-resilience.ts` | `adversity.ts` |
| `adversity-slicer-framing.ts` | `adversity.ts` |
| `adversity-reset-peer-recovery.ts` | `adversity.ts` |
| `adversity-timeout-surface.ts` | `adversity.ts` |
| `adversity-slow-close-cleanup.ts` | `adversity.ts` |
| `schema-exhaustive-fuzz.ts` | `boundary.ts` |

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`TRANSPORT_PROPERTIES: ReadonlyArray<(ctx: ConformanceRunContext) => void>`
in the order legacy `_shared/suite.ts` invokes them. The aggregator
walks the array; reorder is a behavior change.

## Caller-controlled timeout placement

`caller-controlled-app-callback-timeout` sits in `transport/` rather
than `app/` because the property exercises the caller-side timeout
primitive on `sendRpc` — a transport surface — not the app-callback
semantics it happens to drive. Argued either way; transport wins
because the invariant is about the wire timeout fired locally, not
about app-host behavior.

## Schema exhaustive fuzz placement

`schema-exhaustive-fuzz` lives in `transport/` because schemas ARE
wire artifacts. It happens to span every layer's payloads, but the
invariant under test is "the wire decoder rejects malformed
inputs" — a transport-tier statement.
