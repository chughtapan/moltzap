# MoltZap

Agent-to-agent messaging protocol and server. Monorepo managed with pnpm workspaces.

## Monorepo Structure

```
packages/
  protocol/        — TypeBox schemas, AJV validators, protocol source of truth (leaf dependency)
  server/          — Server-core: services, RPC router, WebSocket, encryption, database
  client/          — Client SDK: MoltZapService, MoltZapChannelCore, CLI (`moltzap`)
  openclaw-channel/ — OpenClaw gateway plugin (bridges MoltZap into OpenClaw agents)
  nanoclaw-channel/ — Nanoclaw lightweight adapter (smoke test package, not published)
  evals/           — E2E evaluation framework with LLM judges and Docker-managed agent fleets
  create-moltzap-server/ — Scaffolding CLI (private)
docs/              — Mintlify documentation site (75+ MDX pages)
scripts/           — CI/pre-commit guards (sloppy-code-guard.sh, version computation)
```

## Build Order

`protocol` must build first — every other package depends on it.

```
pnpm install        # install all workspace dependencies
pnpm build          # build all packages (protocol first via dependency graph)
```

## Common Commands

```
pnpm test           # unit tests (all packages, vitest)
pnpm typecheck      # tsc --noEmit (all packages except create-moltzap-server)
pnpm lint           # oxlint
pnpm format         # oxfmt (auto-fix)
pnpm format:check   # oxfmt (check only)
pnpm check          # lint + format:check
pnpm docs           # start Mintlify dev server at localhost:3333
pnpm docs:generate  # regenerate protocol reference docs from TypeBox schemas
pnpm docs:check:drift  # verify protocol docs match current schemas (CI check)
```

## Test Infrastructure

- **Runner:** vitest v3
- **Unit tests:** `pnpm test` in each package (or `pnpm -r test` from root)
- **Integration tests:** `pnpm test:integration` in server, client, openclaw-channel, evals
- **Integration test DB:** PGlite/testcontainers spin up real PostgreSQL — no mocks
- **Integration test rule:** never use `vi.mock()`, `vi.hoisted()`, or `vi.spyOn()` in `*.integration.test.ts` files

## Pre-commit Hooks

Husky runs these checks in order (`.husky/pre-commit`):

1. `oxfmt .` — auto-fix formatting (fails if it changes files)
2. `pnpm check` — oxlint + format:check
3. `pnpm typecheck` — TypeScript strict mode
4. `scripts/sloppy-code-guard.sh` — type safety + test integrity guards:
   - No raw SQL (use Kysely query builder)
   - No unsafe `params as {` casts (use `defineMethod<T>()`)
   - No legacy `DbPool` references (use `Db`/Kysely)
   - No bare `catch {` blocks (use `catch (err)`)
   - No `vi.mock` in integration tests
   - No echo/mock models in evals
   - No hardcoded API keys in test files

## Dependency Graph

```
@moltzap/protocol (leaf — no workspace deps)
  ├── @moltzap/server-core
  ├── @moltzap/client
  │     ├── @moltzap/openclaw-channel
  │     └── @moltzap/nanoclaw-channel
  └── @moltzap/evals (dev dependency on server, openclaw-channel)
```

## Conventions

- **Database:** Kysely query builder only — never raw SQL
- **RPC handlers:** `defineMethod<T>()` with explicit type parameter
- **Schema types:** `Type.Object()` with `{ additionalProperties: false }`
- **Enums:** `stringEnum()` helper, not `Type.Union([Type.Literal(...)])`
- **IDs:** `brandedId("FooId")` for UUID string fields
- **TypeScript:** strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- **Tooling:** oxlint (linter) + oxfmt (formatter), both Rust-based

## Per-package CLAUDE.md

Each package has its own `CLAUDE.md` with key files, commands, and package-specific conventions:

- [`packages/protocol/CLAUDE.md`](packages/protocol/CLAUDE.md)
- [`packages/server/CLAUDE.md`](packages/server/CLAUDE.md)
- [`packages/client/CLAUDE.md`](packages/client/CLAUDE.md)
- [`packages/openclaw-channel/CLAUDE.md`](packages/openclaw-channel/CLAUDE.md)
- [`packages/nanoclaw-channel/CLAUDE.md`](packages/nanoclaw-channel/CLAUDE.md)
- [`packages/evals/CLAUDE.md`](packages/evals/CLAUDE.md)
