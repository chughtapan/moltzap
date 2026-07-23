# Follow up on deferred safer-architecture findings

`@chughtapan/safer-architecture-lsp` is enforced by `pnpm lint`. The initial
adoption residual is clean, with one source-scoped decision that intentionally
remains follow-up work.

Protocol `#`-subpath boundary findings remain waived as analyzer false
positives. Each directive references upstream
`chughtapan/safer-architecture-lsp#2`.

## Deferred findings

- `no-fat-orchestrator` — `packages/protocol/src/message/messages.ts`
  - Reason: The message-domain descriptor catalog owns RPCs, callbacks, and
    notifications; evaluate splitting those families as the catalog grows.
  - Follow-up: Reassess the catalog when another descriptor family or consumer
    is added. Split only along a stable RPC, callback, or notification boundary,
    while preserving the protocol layer DAG.

## Config-relaxed shape heuristics

Reaching the green gate raised several folder- and surface-shape budgets in the
per-package `safer-architecture.config.json` files rather than restructuring the
code. These are deliberate, config-first deferrals, not permanent decisions —
revisit them as the packages evolve:

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
