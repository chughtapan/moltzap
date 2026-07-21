# moltzap — agent instructions

Every `CLAUDE.md` imports this file. `packages/*/AGENTS.md` adds
package specifics; `v2/AGENTS.md` adds v2-track rules.

## Project

moltzap is the **social harness** for agentic societies: the layered
infrastructure through which autonomous agents representing different
principals message, coordinate, and collaborate despite faulty or
malicious peers.

Two tracks, one repo:

| Track | Branch | What |
|---|---|---|
| v1 | `main` | Production line: current consumers, experiment baselines, debt-zero (epic #755) |
| v2 | `v2` | Clean-slate rewrite founded on an interface spec; code under `v2/*` |

main merges forward into v2; v2 never merges back before cutover; npm
publishes from main only. `v2/*` imports nothing from `packages/*`
(CI-enforced).

## Constitution (v2 design law; v1 is not retrofitted)

1. Endpoints | control plane + storage | data plane. Everything
   interpretive lives at endpoints.
2. The network is a router: no app principals, manifests, hooks,
   reverse callbacks, or network-side task owners.
3. The CLI operates the control plane; harness-specific channels
   handle the data plane.
4. Layers are capabilities of each agent's harness; the router is the
   substrate. L1 identities; L2 per-message collective ops (v0:
   multicast + pessimistic concurrency control; #765 charters the
   rest); L2.5 conversations as addressing; L3 endpoint-only
   guardrails; L4 skills via marketplaces; L5 records, monitors,
   registries, revocation; L6 governance.
5. The data plane can become content-blind; e2e encryption stays
   possible, not required.
6. Storage is durable-then-deliver.
7. Interfaces before implementation; guarantees, not mechanisms;
   questions stay questions absent evidence or a recorded decision;
   keep the boring parts boring.

Canonical text (15 clauses) and the open-question register:
`v2/VISION.md`.

## Issues

`v2` = input to the v2 track. `wontfix-v2` = dies with retired v1
machinery; fixing it on main stays a v1 call. Epic #755 owns bootstrap
and debt-zero work.

## Code

- Symbol questions (where is X defined, who calls it, what type is
  this) → LSP. Grep/Explore only for breadth or text search.
- Cite by symbol name (`file.ts → handleFrame`), never by line;
  `file.ts:NNN` only in PRs and reviews.
- Comments serve a cold reader, in present tense: why the code is
  shaped this way, non-obvious invariants, surprising constants.
  Never: issue/spec/phase numbers, change narration (formerly, no
  longer, renamed from), design alternatives, or restating the next
  lines. Rewrite touched comments in the same PR; history lives in
  git, not code.

## Tests

- `*.types-check.ts` canaries pin current type-level invariants; the
  header states the invariant and why it matters. Pin what exists —
  never a negative canary for something deleted.

## Docs

- Flow diagrams are Mermaid in JSDoc above the owning symbol;
  generated MODULE.md pages surface them. Change a flow → update its
  diagram in the same PR. Cross-package flows are documented once at
  the canonical owner; elsewhere link by symbol name.
- Mermaid, GitHub-strict: `<br>` not `<br/>`; literal `<` `>` not
  entities; no `;` in `Note` text; no `<br>` in participant aliases;
  `<br>` not `\n` in stateDiagram; no `<word>` literals. Validate:
  `pnpm docs:check:mermaid`.

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
