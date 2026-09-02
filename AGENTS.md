# moltzap — agent instructions

Every `CLAUDE.md` is a symlink to the `AGENTS.md` beside it. `packages/*/AGENTS.md` adds
package specifics. Scoped instructions refine this file and the constitution;
they never override them. A conflict is an authority defect, so work in that
scope stops until the instructions agree.

State only what a check cannot. If `pnpm lint` fails on it, name the check
rather than repeating the rule — prose that duplicates a linter costs context
every turn and drifts from the behavior that is actually enforced.

## Project

moltzap is the **social harness** for agentic societies: the layered
infrastructure through which autonomous agents representing different
principals message, coordinate, and collaborate despite faulty or
malicious peers.

`main` is the only track. The four-layer harness lives in seven packages under
`packages/*`; five publish to npm as one calendar version set and
`@moltzap/nanoclaw-channel` and `@moltzap/evals` stay private, per
`docs/decisions/20260901-six-packages-publish-as-one-version-set.md`.
Releases run from `main` through `.github/workflows/publish.yml` on manual
dispatch.

**The constitution is `docs/vision.md` → The constitution.** It is canonical
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
| `/simplify` on Opus, then `/ship` | open a PR |
| `/plan-eng-review` | start implementing a feature |
| `/land-and-deploy` | merge |
| `codex`, authenticated and in quota | call review complete |
| `gbrain` reachable (`gbrain doctor`) | verify decision provenance |

**Refuse where the failure is silent; warn where it is loud.** A missing binary
that errors on first use needs no rule. `/ship` without codex quietly downgrades
its own pre-landing review to a single-model pass *and still records a clean Eng
Review entry* — the bar drops and nothing says so.

`/ship` carries the pre-landing review, the specialist fan-out, and the always-on
adversarial pass, so a separate `/review` ahead of it repeats that work at the
same bar. `/simplify` covers the axis review does not, and it runs on Opus: it
fans several reviewers over the whole diff, and the Fable limit is account-wide,
so a Fable `/simplify` stalls every other agent in the workspace.

Name your connected sources (Notion, Gmail, Discord, GitHub) when work may have
been decided elsewhere, and offer to read them directly. This is agent law
rather than a `SessionStart` hook because an agent can see its own connected MCP
servers and a shell hook cannot.

## Change guidance

Load the Google guide that matches the work: `google-typescript-style` for
`.ts`, `google-javascript-style` for the `.mjs` tooling, `google-shell-style`
for `.sh`, `google-swe-testing`, `google-documentation-guide`,
`google-swe-change-management`, `google-swe-builds-dependencies-and-ci` for
build, dependency, and CI policy, `google-swe-engineering-standards` for the
lint and architecture gates themselves, and the applicable Google code-review
author or reviewer guide. New code meets its guide in the commit that
introduces it; existing code is brought along by the change that touches it.
Repository law, Effect conventions, Nx, ESLint, oxfmt, and scoped package
instructions take precedence. Link to the guide rather than copying it into the
repository, and keep tests and documentation in the change they explain.

gstack reviews compose with the Google guides where they apply.

| Guide | Loaded by |
|---|---|
| `google-code-review-reviewer` | `/ship`'s structured review |
| `google-swe-testing` | `/ship`'s testing specialist; `/plan-eng-review`'s test review |
| the same language guides | `/ship`'s maintainability specialist; `/plan-eng-review`'s code-quality review |
| `google-swe-engineering-standards` | the same two, for changes to the lint or architecture gates |
| `google-swe-builds-dependencies-and-ci` | `/plan-eng-review`'s architecture review; `/ship` for workflow, Nx, manifest, or release-script changes |
| `google-swe-compute-platforms` | either, for cluster execution: profiles, admission, run namespaces, images, Temporal |
| `google-swe-change-management` | `/ship`'s data-migration and api-contract specialists; `/plan-eng-review`'s scope challenge |
| `google-swe-code-review-systems` | either, for changes to a gate, a review regime, or this file |
| `google-documentation-guide` | either, for documentation claims |

## Issues

Labels `v2` and `wontfix-v2` are historical: `v2` marked input to the
four-layer replacement that is now `main`; `wontfix-v2` marked defects that
died with the retired v1 machinery. Epic #755 tracks bootstrap and debt-zero
work.

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
  `file.ts:NNN` only in PRs, reviews, and issues.
- Rationale goes in JSDoc on the symbol it explains, in the commit
  message, or in a docs file — never scattered inline through a body. A
  `//` line inside a body moves to that symbol's JSDoc or goes; if it
  will not fit there, the function is doing too much. A line directly
  above a named thing sits on that symbol, not in the body: an
  object-literal property, a `const`, an `it`. Lint-disable
  justifications are the exception.
  A shell script's header block is its JSDoc. Write for a cold reader
  in present tense: why the code is shaped this way, non-obvious
  invariants, surprising constants. If deleting a comment loses nothing
  the name and signature already give, delete it, including any doc line
  that repeats the symbol it sits on. `@param` and `@returns` go as a
  whole set or not at all, since a partial set fails
  `jsdoc/check-param-names`; fold what a parameter carries beyond its type
  into the description prose. Lint requires a block on every export, so
  rewrite an export block to say what the name cannot rather than
  deleting it.
  `.mjs` and `.js` carry the JavaScript guide's typed annotations, which
  no signature gives. Never issue/spec/phase numbers, change narration
  (formerly, no longer, renamed from), or design alternatives. Rewrite
  touched comments in the same PR; history lives in git, not code.
- Fix every instance of a defect or wrong pattern, not the reported
  one: grep `packages/`, `scripts/`, `tools/`, `bin/`, `.github/`, and
  `docs/`, and fix all of it in the same change; one corrected call
  site with five untouched siblings is a regression waiting to be
  rediscovered. Style and guide conformance is the exception, and
  follows the file the change touches.
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

- Authority order is: this agent law and `docs/vision.md`; current ADR
  outcomes, including explicitly retained portions of
  partially-superseded records; normative `docs/spec/` chapters;
  architecture orientation and execution plans; historical inputs under
  `docs/decision-evidence/`. A lower source must not contradict a higher
  source.
- Before a public-boundary change, the governing spec and decision
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
