# Conformance — `identity/` layer

Authority + agent-identity invariants. Every property here exercises
"who is allowed to call what" — positive-path checks where the actor
has authority, and negative-path rejections where they don't.

## Property files

| File | Carved from |
|---|---|
| `authority-positive.ts` | `rpc-semantics.ts` |
| `authority-negative.ts` | `rpc-semantics.ts` |

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`IDENTITY_PROPERTIES` in the order legacy `_shared/suite.ts` invokes
them.

## Why identity has only two properties today

Registration / claim / contacts / agent-listing invariants currently
live as integration tests under `packages/server/src/__tests__/integration/`,
not as conformance properties. As the layered suite grows (e.g.,
"registration is idempotent under retry"), new identity-tier properties
land here as their own file — no monolith to carve them out of.
