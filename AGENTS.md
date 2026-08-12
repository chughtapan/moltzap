# moltzap — agent instructions

Every `CLAUDE.md` is a symlink to the `AGENTS.md` beside it. `packages/*/AGENTS.md` adds
package specifics; `v2/AGENTS.md` adds v2-track rules.

State only what a check cannot. If `pnpm lint` fails on it, name the check
rather than repeating the rule — prose that duplicates a linter costs context
every turn and drifts from the behavior that is actually enforced.

## Project

moltzap is the **social harness** for agentic societies: the layered
infrastructure through which autonomous agents representing different
principals message, coordinate, and collaborate despite faulty or
malicious peers.

The cutover keeps two histories in one repository while the replacement stack
is assembled:

| Track | Branch | What |
|---|---|---|
| Retiring v1 | `main` | Published production baseline and source for fixes that are deliberately ported |
| Four-layer cutover | `cutover/four-layer-v2` | Replacement authority and the seven final packages under `packages/*` |

The cutover branch takes one final pinned integration of the accepted PR #974
state and its `main` base. Routine `main`-to-cutover merges are then frozen:
later v1 fixes move only by deliberate, reviewed port. The cutover never merges
back before replacement. npm continues publishing from `main` until the
release cutover is admitted. `v2/*` is authority and historical input, not a
second implementation tree; executable product code finishes under
`packages/*`.

**The v2 constitution is `v2/VISION.md` → The constitution.** It is canonical
there and paraphrased nowhere, this file included: two copies at the top of the
same authority order drift, and the drift is invisible.

## Prerequisites

Run `pnpm check:agent-setup` once per session — not per command, which is how
the old 165s pre-commit happened. Refuse the operation whose row is unmet.
Refusal is scoped: a missing `codex` never blocks editing a file, or fixing
the setup itself.

| Required | Refuse to |
|---|---|
| Node per `.node-version`, pnpm | do anything |
| `pnpm nx` for every task, never the underlying tool | build, test, lint, typecheck |
| Effect and `@effect/*` as the runtime idiom | add a non-Effect alternative |
| `/simplify`, `/ship`, `/review` | open a PR |
| `/plan-eng-review` | start implementing a feature |
| `/land-and-deploy` | merge |
| `codex`, authenticated and in quota | call review complete |
| `gbrain`, connected | verify decision provenance, or run the blind gate |

**Refuse where the failure is silent; warn where it is loud.** A missing binary
that errors on first use needs no rule. `/review` without codex quietly becomes
a single-model pass *and `/ship` still records a clean Eng Review entry* — the
bar drops and nothing says so.

Name your connected sources (Notion, Gmail, Discord, GitHub) when work may have
been decided elsewhere, and offer to read them directly. This is agent law
rather than a `SessionStart` hook because an agent can see its own connected MCP
servers and a shell hook cannot.

## Issues

`v2` = input to the v2 track. `wontfix-v2` = dies with retired v1
machinery; fixing it on main stays a v1 call. Epic #755 owns bootstrap
and debt-zero work.

## Decisions

`docs/decisions/` is the durable log; `docs/decision-evidence/` holds the
source-event ledgers it cites. **Admission is maintainer-gated** — an agent
proposes, a human admits.

Load the `decisions` skill — `.claude/skills/decisions/SKILL.md`, plain
Markdown readable by any tool — before adding, editing, superseding, or
reviewing a record, or before compacting a trajectory. It carries the
procedure, the provenance rules in `references/provenance.md`, and the blind
review gate. `scripts/docs/adr/check-shape.ts` enforces the mechanical half in
`pnpm lint` and at commit time.

## Code

- Symbol questions (where is X defined, who calls it, what type is
  this) → LSP. Grep/Explore only for breadth or text search.
- Cite by symbol name (`file.ts → handleFrame`), never by line;
  `file.ts:NNN` only in PRs and reviews.
- Rationale goes in JSDoc on the symbol it explains, in the commit
  message, or in a docs file — never scattered inline through a body.
  A shell script's header block is its JSDoc. Write for a cold reader
  in present tense: why the code is shaped this way, non-obvious
  invariants, surprising constants. Never issue/spec/phase numbers,
  change narration (formerly, no longer, renamed from), design
  alternatives, or restating the next lines. Rewrite touched comments
  in the same PR; history lives in git, not code.
- Fix every instance, not the reported one. When a pattern is wrong,
  grep `packages/`, `v2/`, `scripts/`, and `test/` and fix all of it in
  the same change; one corrected call site with five untouched siblings
  is a regression waiting to be rediscovered.
- A fix should shrink the system. Prefer removing or consolidating over
  adding a layer, flag, or special case.

Effect idiom, typed errors, exhaustive switches, and cast bans are enforced by
`lint:sloppy-code-guard` and the `agent-code-guard` eslint rules. Read their
output rather than a summary of it here.

## Tests

- `*.types-check.ts` canaries pin current type-level invariants; the
  header states the invariant and why it matters. Pin what exists —
  never a negative canary for something deleted.

## Verify

Run the tests covering what you changed, plus `pnpm lint`, then push and let CI
be the full gate. Judge "affected" by callers rather than diff size; run
everything when you cannot tell what a change reaches.

`pnpm lint` needs a prior `pnpm build` — typed linting resolves against built
`.d.ts` outputs, and CI builds first.

## Docs

- Authority order for v2 is: this agent law and `v2/VISION.md`; current
  ADR outcomes, including explicitly retained portions of
  partially-superseded records; normative `docs/spec/` chapters;
  architecture orientation and execution plans; historical inputs. A
  lower source must not contradict a higher source.
- Before v2 implementation changes, the governing spec and decision
  traceability must be complete. No binding decision may exist only in
  chat, an issue comment, or an agent-private state directory.

Writing or regenerating documentation is a procedure, not always-relevant
guidance: load the `docs` skill (`.claude/skills/docs/SKILL.md`).

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->
