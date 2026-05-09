# _infra/

Bottom-layer peer of `transport/`, `identity/`, `network/`, `task/`,
`app/`. Holds the horizontal concerns every layer reaches for: db
client, crypto, config loading, runtime helpers, runtime-surface
(observability), webhook adapters, test utilities.

The leading underscore is the visual cue that `_infra/` is below the
protocol stack. It is named explicitly in `architectureOptions.layers`
(Phase 4) at the bottom of the layer ordering.

## Post-Phase-2A.2 contents

- `_infra/db/` (from `db/`) — Kysely client, snowflake IDs,
  effect-kysely toolkit, generated types.
- `_infra/crypto/` (from `crypto/`) — envelope encryption, key rotation,
  payload (de)serialization.
- `_infra/config/` (from `config/`) — schema, loader, effect-config.
- `_infra/runtime/` (from `runtime/`) — InvalidParamsError, validator,
  coalesce.
- `_infra/runtime-surface/` (from `runtime-surface/`) — observability,
  trace capture, runtime logging.
- `_infra/adapters/` (from `adapters/`) — webhook client.
- `_infra/test-utils/` (from `test-utils/`) — pglite-harness, fakes,
  rpc-error helpers.

## Public surface

`@moltzap/server-core/_infra` re-exports the union of `_infra/<sub>/`
barrels. The pre-existing `@moltzap/server-core/test-utils` subpath
stays additive: post-2A.2 it retargets to
`./dist/_infra/test-utils/index.js` to preserve cross-package
consumers (`@moltzap/client`, `packages/runtimes`) without source
changes.

## Import policy (this is the special one)

| From      | To              | Allowed?                          |
|-----------|-----------------|-----------------------------------|
| any layer | _infra          | Yes                               |
| _infra    | transport       | NO                                |
| _infra    | identity        | NO                                |
| _infra    | network         | NO                                |
| _infra    | task            | NO                                |
| _infra    | app             | NO                                |
| _infra    | _infra (sibling)| Yes (siblings inside _infra)      |

The directional rule is the contract `architectureOptions.layers`
encodes for moltzap. Violations are a lint error post-Phase-4.
