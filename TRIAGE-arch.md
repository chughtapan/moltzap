# Architecture tooling status

`@chughtapan/safer-architecture-lsp` is configured for the exact seven-package
workspace: Identity, Router, Client, OpenClaw, NanoClaw, Simulator, and Evals.
The retired umbrella protocol and server packages have no project, config, or
waiver ledger in the cutover graph.

Architecture checks are blocking rather than deferred:

- `pnpm arch:check` runs every package's `arch:check` target with the required
  Node heap;
- `pnpm lint` runs the exact graph and boundary check, validates generated
  architecture configs, and depends on each package's architecture and lint
  targets; and
- CI executes the common build, typecheck, test, lint, and architecture floor
  for all seven packages.

## Configured budgets and waivers

Each `packages/*/safer-architecture.config.json` records the current package
shape. Refresh and review those files with:

```sh
pnpm arch:config:generate
pnpm arch:config:check
```

Source-specific exceptions remain inline beside the affected declaration as
`safer-arch-ignore` directives. They belong to their current owner package and
must not name or preserve a retired package boundary. Inspect the live source
ledger with:

```sh
rg -n "safer-arch-ignore" packages/*/src
```

Treat any future budget increase or new waiver as an architecture review point
rather than silently relaxing the generated configuration.
