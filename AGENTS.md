# moltzap — agent instructions

## Start every task

Load the applicable skills before planning, lookup or editing. This is the
agent's responsibility; an ordinary user request is sufficient and need not
name a skill. Invoke the host's Skill tool when available; otherwise read the
entire `SKILL.md` at the path below. Listing a skill, remembering a previous
session or checking its hash does not load its instructions.

| Task | Load |
| --- | --- |
| Plan a change or prepare a handoff | `.agents/skills/shared-sdlc/SKILL.md` |
| Find, file or review an internal record | `.agents/skills/records/SKILL.md` |
| Write or edit public documentation | `.agents/skills/docs/SKILL.md` |

Load only applicable skills, then follow their targeted references. If private
docs are unavailable, use the installed skills' public-maintenance fallback.
Do not ask the user to invoke skills or install optional helpers for you.

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

`main` is the only track. The four-layer harness lives in six packages under
`packages/*`; five publish to npm as one calendar version set and
`@moltzap/nanoclaw-channel` stays private, per
`docs/spec/layer-interfaces.md` → Publication and versions.
Releases run from `main` through `.github/workflows/publish.yml` on manual
dispatch.

**The constitution is `docs/vision.md` → The constitution.** It is canonical
there and paraphrased nowhere, this file included: two copies at the top of the
same authority order drift, and the drift is invisible.

## Workflow

Understand the task → make a design decision if needed → implement and test →
independent review → ship. An existing request or issue authorizes bounded work;
do not ask for a separate plan approval unless the scope changes.

- A routine fix needs an issue/PR description and appropriate checks.
- A coordinated feature needs one plan.
- A durable architecture, public interface, security, persistence, or package
  ownership choice needs one complete source-backed ADR and independent review.
  An agent cannot invent the owner's approval or treat a reviewer PASS as
  decision authority.
- Update the existing PR/plan for a handoff. Add a separate handoff only when
  those records cannot carry what the next agent needs.

Shared workflow and internal decisions live in
[`social-harness/docs-internal`](https://github.com/social-harness/docs-internal/blob/a5b6dbd077dfe16a8fc41c6135703253a67e9402/README.md).
Set `DOCS_INTERNAL_ROOT` to a checkout at the revision recorded in
`.agents/company-skills.json` and start with its README. That revision pins the
workflow and navigation; it does not approve proposed decisions. Public
contracts remain the implementation baseline until a change is admitted.
Agree on a complete decision candidate before starting its admission review;
do not automatically review intermediate drafts.
Both hosts use the revision in `.agents/company-skills.json`; sync and
check updates with that checkout's `bin/records skills` commands.

Public usage, specifications, package instructions, and runnable checks stay in
this repository. Without private docs or optional skills, maintain public code
using these contracts, normal planning, independent review, and Git/PR commands.
A proposed boundary change must resolve its affected decision evidence before
claiming approval. Missing private access does not block unrelated maintenance.

Use an isolated worktree for concurrent changes, preserve other people's work,
and confirm branch, commit, uncommitted changes, existing checks, and next action
before resuming a handoff. Keep useful current evidence; do not commit failed-run
exports, old attempt logs, or duplicate summaries.

## Toolchain and skills

Use Node from `.node-version` and the pnpm version in `package.json`. Run build,
test, lint, and typecheck through `pnpm nx` or the package scripts that wrap it.
Effect and `@effect/*` are the runtime idiom.

Use applicable Google language, testing, documentation, and code-review guides
when available. gstack planning/review/shipping skills are optional helpers;
missing tools do not lower the review bar or block work that can use the normal
workflow. State which checks and reviews actually ran. Repository instructions,
Effect conventions, Nx, ESLint, and oxfmt take precedence over optional guidance.

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

Read this file and `docs/vision.md`, then the applicable public contract under
`docs/spec/` and package instructions. Architecture pages explain the current
implementation. Internal ADRs and original source evidence belong in the shared
docs repo. Reconcile a boundary change with its public specification; do not
leave a binding interface contract only in private docs, chat, or agent state.

Writing or regenerating public docs uses the `docs` skill at
`.agents/skills/docs/SKILL.md`; `.claude/skills/docs` links to the same source.
Keep repository-owned skills under `.agents/skills/` with a matching Claude
link. Update the pinned company skills through `bin/records skills sync`.
Generated files come from their source and must not be edited by hand.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, use the `nx-workspace` skill when available - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), use the `nx-generate` skill when available; otherwise inspect the generator help before running it

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->
