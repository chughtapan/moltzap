# @moltzap/evals

E2E evaluation framework for MoltZap — runs multi-agent scenarios against real infrastructure, scored by LLM judges.

## Key Files

- `src/e2e-infra/index.ts` — CLI entry point (`pnpm eval:e2e`)
- `src/e2e-infra/runner.ts` — Scenario runner: orchestrates agent fleets, collects transcripts, invokes judges
- `src/e2e-infra/scenarios.ts` — Scenario definitions (multi-agent conversation flows)
- `src/e2e-infra/llm-judge.ts` — LLM-as-judge evaluation (uses Claude Agent SDK)
- `src/e2e-infra/agent-fleet.ts` — Agent fleet management (spawn, coordinate, teardown)
- `src/e2e-infra/docker-manager.ts` — Docker container lifecycle for eval environments
- `src/e2e-infra/nanoclaw-manager.ts` — Nanoclaw process management for eval agents
- `src/e2e-infra/nanoclaw-smoke.ts` — Smoke test runner for nanoclaw channel
- `src/e2e-infra/model-config.ts` — LLM model configuration for judges
- `src/e2e-infra/report.ts` — Eval report generation and formatting
- `src/e2e-infra/types.ts` — Shared type definitions
- `src/e2e-infra/logger.ts` — Winston-based structured logging

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest (passWithNoTests)
- `pnpm test:integration` — vitest integration tests
- `pnpm eval:e2e` — run full E2E evaluation suite
- `pnpm build:docker` — build Docker image for eval agents

## Testing Rules

- Evals must use real LLMs — never reference echo/mock models in `src/`
- The `sloppy-code-guard.sh` script checks for `echo-server`, `echo-1`, `mock.*model`, `ECHO:` patterns
- API keys come from environment variables, never hardcoded

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — LLM judge invocation
- `@sinclair/typebox` — scenario type schemas
- `pg` — direct database access for eval verification
- `winston` — structured logging
- `yargs` — CLI argument parsing
- `@moltzap/protocol`, `@moltzap/server-core`, `@moltzap/openclaw-channel` (devDependencies) — for integration tests
