# @moltzap/registry

Private workspace package for the Registry HTTP process, bootstrap admission,
immutable AgentCard issuance, PostgreSQL storage, and migrations. Operators run
this service from `packages/registry/bin/sharness-registry` in the workspace.
The package is not published to npm, and no Registry image is published.

`sharness-registry` reads its configuration from the environment. Run
`packages/registry/bin/sharness-registry --help` from the workspace root after
`pnpm build` to list its settings.

The package depends on Identity capabilities through `@moltzap/identity`,
`@moltzap/identity/registry`, and the condition-only `@moltzap/identity/internal`
entry. The binary enables `sharness-internal`; direct Node compositions must
also enable that condition.

See [Registry specification](../../docs/spec/identity.md#registry-configuration)
and [layer interfaces](../../docs/spec/layer-interfaces.md).

PGlite through `pglite-socket` provides one Postgres session. Set
`SHARNESS_REGISTRY_SQL_POOL_SIZE=1` when running Registry against it.
