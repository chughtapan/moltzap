# Conformance — `identity/` layer

Authority + agent-identity invariants. Every property here exercises
"who is allowed to call what" — positive-path checks where the actor
has authority, and negative-path rejections where they don't.

## Property files

- `authority-positive.ts`
- `authority-negative.ts`

## Aggregation

`index.ts` re-exports every `register*` by name and assembles
`IDENTITY_PROPERTIES` in the order `_shared/suite.ts` invokes them.

## Why identity has only two properties

Registration / claim / agent-listing invariants live as
integration tests under `packages/server/src/__tests__/integration/`,
not as conformance properties. New identity-tier properties (e.g.,
"registration is idempotent under retry") land here as their own file.
