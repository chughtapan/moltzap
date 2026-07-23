# Follow up on deferred safer-architecture findings

`@chughtapan/safer-architecture-lsp` is enforced by `pnpm lint`. The initial
adoption residual is clean, with two source-scoped decisions that intentionally
remain follow-up work.

## Deferred findings

- `no-fat-orchestrator` — `packages/protocol/src/message/messages.ts`
  - Reason: The message-domain descriptor catalog owns RPCs, callbacks, and
    notifications; evaluate splitting those families as the catalog grows.
  - Follow-up: Reassess the catalog when another descriptor family or consumer
    is added. Split only along a stable RPC, callback, or notification boundary,
    while preserving the protocol layer DAG.

- `no-public-vendor-type-leak` —
  `packages/server/src/test-utils/index.ts`
  - Reason: The test harness exposes live Kysely and OpenTelemetry handles used
    by integration tooling; define server-owned test ports before removing
    them.
  - Follow-up: Introduce package-owned test-harness ports for the database,
    server process, and span exporter, then migrate downstream integration
    consumers and remove the waiver. This one directive covers two original
    diagnostics.

## Config-relaxed shape heuristics

Reaching the green gate raised several folder- and surface-shape budgets in the
per-package `safer-architecture.config.json` files rather than restructuring the
code. These are deliberate, config-first deferrals, not permanent decisions —
revisit them as the packages evolve:

- `minFolderReadmeChildren` was raised (client 26, runtimes 14, server 14,
  protocol 13), which suppresses `folder-readme-required` for the current tree.
  Follow-up: add `README.md` boundary statements to the larger folders and lower
  the threshold back toward the default (4).
- `maxPublicExports` / `maxPublicReexports` / `minPublicFacadeModules` /
  `minExportedSiblingModules` / `maxSubpathExports` were raised to match each
  package's present curated surface. Follow-up: treat a future increase as a
  prompt to split the surface rather than raise the budget again.

## Acceptance criteria

- The replacement boundaries preserve the existing public testing and protocol
  contracts or include an intentional migration plan.
- The corresponding `safer-arch-ignore` directive is removed.
- `pnpm arch:check`, `pnpm lint`, `pnpm build`, and
  `pnpm exec nx run-many -t typecheck:tests` remain green.

Inspect the live waiver ledger with:

```sh
pnpm exec safer-architecture-lsp check packages/protocol --waivers
pnpm exec safer-architecture-lsp check packages/server --waivers
```
