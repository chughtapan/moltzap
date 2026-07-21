# moltzap — agent instructions

Single source of instructions for every coding agent (Claude, Codex,
or otherwise). All `CLAUDE.md` files in this repo are pointers to their nearest `AGENTS.md`.
Per-package `AGENTS.md` files under `packages/*/` extend these;
`v2/AGENTS.md` extends them for work on the v2 track.

## What this project is

moltzap is the **social harness** for agentic societies: the layered
infrastructure through which autonomous agents representing different
principals message, coordinate, and collaborate without livelocking,
stalling, or being steered by faulty or malicious peers.

The project is changing architectures, run as **two tracks in one
repo**:

| Track | Branch | What it is |
|---|---|---|
| v1 | `main` | The production line: serves current consumers, generates experimental baselines, and clears its mapped debt (the debt-zero children of epic #755) |
| v2 | `v2` | The clean-slate rewrite, founded on an interface spec (`docs/spec/` on that branch; `v2/AGENTS.md` has its current state); code lives under `v2/*` |

Track policy: main merges **forward** into v2 after every ratchet (a
merged increment of the debt-zero / guardrail work under epic #755)
lands; v2 never merges back until cutover (the maintainer-recorded
switch to v2, tracked on epic #755); npm publish happens from main
only, until cutover. `v2/*` code imports nothing from
`packages/*` — enforced by the architecture boundary check in
`pnpm lint` (see Ground rules).

## The constitution (v2 design law; v1 is not retrofitted to it)

1. Three-way separation: **endpoints | control plane + storage | data
   plane**. Everything interpretive lives at endpoints.
2. **The network is a router.** No app principals, no manifests, no
   hooks, no reverse callbacks, no network-side task owners.
   Coordination logic lives in endpoint skills.
3. Control-plane ops are operated via the CLI (the operator face of
   control-plane RPCs, which automation can also drive); data-plane
   ops are handled by harness-specific channels.
4. The six layers are capabilities of each agent's social harness;
   the router is the shared substrate. L1 unforgeable identities;
   L2 per-message collective operations (first version: multicast
   groups with pessimistic concurrency control; #765 charters the
   rest); L2.5 conversations as first-class addressing;
   L3 per-agent guardrails at endpoints only (personal trust — the
   router enforces none of it); L4 norms as marketplace-distributed
   skills; L5 records, monitors, registries, revocation; L6
   governance.
5. The data plane can become content-blind; end-to-end encryption is
   a preserved possibility, not a current requirement.
6. Storage is durable-then-deliver.
7. Interfaces before implementation; guarantees, not mechanisms, in
   spec language; questions stay questions until evidence or a
   recorded maintainer decision answers them. Keep the boring parts
   boring (calendar versioning, existing registries, existing docs
   pipeline).

The list above is a summary; the canonical constitution (15 clauses),
the full vision, and the open-question register live in
`v2/VISION.md`.
Ecosystem: `VidushiS/moltzap-propagation-bench` and
`chughtapan/moltzap-arena` are
external case studies; the framework never absorbs their frontends or
scenario logic — a case study reaching into internals is an interface
gap by definition.

## Issue conventions

- `v2` label: the issue is aligned input to the v2 track.
- `wontfix-v2` label: bound to v1 machinery the constitution retires;
  it will not be carried into v2. Whether it still gets fixed on main
  is a maintainer call on the v1 track.
- The v2 bootstrap epic (#755) and its children own infrastructure and
  debt-zero work.

## Ground rules

- Read the relevant package `AGENTS.md` before editing a package.
- `pnpm lint` must stay green; it includes the architecture boundary
  checks (`scripts/check-architecture-boundaries.js`).

## Architecture documentation

Flow diagrams live in JSDoc next to the symbol they describe, NOT in
sibling `ARCHITECTURE.md` / `docs/architecture/*.md` files. The
auto-generated module pages (`packages/*/src/**/MODULE.md`) surface
the JSDoc-borne diagrams for the published surface; the diagram is
wrong the moment the code drifts. This section governs code
documentation on both tracks; v2 spec chapters under `docs/spec/` are
normative interface text, not architecture docs, and sit outside this
rule's scope.

- **When you change a flow** (request routing, state machine,
  dispatcher logic, lifecycle, error handling, etc.), update the
  Mermaid block in the JSDoc above the symbol that owns the flow in
  the same PR. Cite by symbol name, not line number — the citation
  rule below applies.
- **When you add a new flow** that warrants its own diagram, write
  it as a Mermaid block in the JSDoc above the entry-point symbol
  for that flow. Cross-package flows (e.g., lease handoff between
  server and channels) live ONCE in the canonical owner's JSDoc;
  every other site links by symbol name.
- **Cold-reader content** (project structure, glossary, conventions,
  data stores) lives in the package's `AGENTS.md` and matching
  folder-level `README.md` files (`src/<folder>/README.md`) — wherever
  a newcomer naturally lands when reading the source.

### Code analysis — prefer LSP over Explore for tracing

When tracing how code is wired (definition, references, callers, type
flow, signature evolution), use the LSP first. Explore-style search
agents are read-windowed: they grep a region and stop, so they
will miss content past the window AND miss symbol-aware relationships
(rename targets, implementations of an interface, downstream callers
of a generic method).

LSP, by contrast, is the compiler's own view of the code: every
`go to definition`, `find references`, and `type at cursor` answer is
ground-truth for the current tree. Architects, implementers, and code
reviewers should default to LSP for these questions:

- *Where is `X` defined?* → LSP definition (one hop, type-aware)
- *Who calls `X`?* → LSP references / callers (covers all variants,
  including renamed re-exports)
- *What does this generic `T` resolve to here?* → LSP type-at-cursor
- *Which interfaces does `Y` implement?* → LSP implementations
- *Why does the compiler reject this signature?* → LSP diagnostics at
  point + inferred type

Reserve Explore agents for:

- *Where might this feature be?* (no symbol name yet — pure breadth search)
- *Search for a string literal or comment pattern* (LSP can't help)
- *Tree-wide grep for a regex* (one-shot, accept the read window)

If you find yourself using Explore to answer a "who/what/where" symbol
question, you are paying read-window cost for a question LSP would
answer canonically. Switch.

For agents dispatched via `/safer:*` modalities, this preference is a
hard rule: architect and implement teammates use LSP to trace code
semantics; Explore is opt-in for breadth-only questions.

### Citation style — symbol names, not line numbers

Cite functions/classes/methods by name, never by line. `file.ts:123`
rots at the next refactor; `file.ts → handleFrame` survives because
the symbol is grep-able. For a code block inside a function, use
the enclosing function plus a verbal pointer:
`server.ts → handleFrame, the Match.value dispatch block`.

The only acceptable uses of `file.ts:NNN` are in PR descriptions, code
review comments, and investigation reports — short-lived artifacts
pinned to a specific commit.

### Comment & canary discipline — cold-reader rule

Write every comment for a cold reader who starts from `main` today
with no memory of how the code got here. If a sentence only makes
sense to someone who watched a spec get written or an issue get
closed, it is debt — strip it.

This extends the citation rule above from line numbers to migration
history. `#560`, `Spec D3 R14b`, `Phase 9b`, `architect plan §3` rot
the same way `file.ts:123` does, and for the same reason: a fresh
reader cannot act on them. Provenance lives in the PR description, the
CHANGELOG, and `git log` — never in long-lived code.

**KEEP** (load-bearing for a cold reader):

- Present-tense rationale — *why* the code is shaped this way, stated
  as a current fact ("split into two schemas so callers that must not
  see the privileged field cannot reference it").
- Non-obvious invariants the types don't already state ("one-way
  transition, enforced by `WHERE status = 'waiting'`").
- Surprising-constant justifications ("capacity 8192 to hold the
  burst envelope").
- Cross-references by **symbol name** to the canonical owner (per
  Cross-package DRY below) — never "see #683".
- Mermaid diagrams in JSDoc (per Architecture documentation above).
- `eslint-disable` / `@ts-expect-error` justifications — the *current*
  reason the escape hatch is needed.

**STRIP** (move to PR body + CHANGELOG + commit message):

- Issue / PR / spec / plan numbers as inline labels (`#560`,
  `Spec F (#617)`, `decision #11`, `risk R8`). No bare `see #NNN`
  pointers either — cross-link by symbol name instead.
- Change narration: `former`, `formerly`, `no longer`, `used to`,
  `pre-cutover`, `deleted in`, `removed in`, `renamed from`,
  `collapsed`, `replaces`, `was a bypassed gate`.
- Design-alternatives-considered and future-work musings ("a future
  ack-then-notify variant could…").
- Comments that restate the next one to three lines of code.

When you change a flow, rewrite the touched comment to present tense
in the same PR — don't append a "now X (was Y)" breadcrumb. The diff
plus the CHANGELOG entry carry the history; the code carries the
truth.

**Canaries (`*.types-check.ts`).** A canary header states the CURRENT
type-level invariant it pins and why that invariant matters for the
live public surface (e.g. "this client constructor requires a handler
at the type level; the canary stops compiling if the slot becomes
optional"). Never narrate how the surface changed, and never write a
negative canary asserting a *deleted* thing is unreachable — pin what
exists now.

### Cross-package DRY

If a flow lives canonically in another package, **link by symbol
name**, don't re-explain it. Example: the dispatch lease FSM lives
canonically in `@moltzap/server-core` on `LeaseRegistry`
(`packages/server/src/dispatch/lease-registry.ts → LeaseRegistry`); channel
JSDoc that touches the lease should link there and describe only its
channel-local concerns (projection logic, local state).

### Mermaid diagrams

Diagrams use Mermaid (GitHub renders them natively). Validate locally
before push — GitHub's parser is stricter than many local renderers.
Common patterns that BREAK GitHub's renderer:

- `<br/>` (XHTML) in `sequenceDiagram` message labels → use `<br>` (HTML5)
- `&lt;` / `&gt;` HTML escapes inside `sequenceDiagram` message text →
  use literal `<` `>` (not operators in message position)
- `;` (semicolon) inside `Note over X: ...` text → use `—` or `,`
  (`;` is a statement terminator)
- `<br>` in `participant X as <label>` aliases → strip; move multi-line
  detail to a sibling `Note over X: ...`
- `\n` literal in `stateDiagram` descriptions → use `<br>`
- `<word>` literals in `stateDiagram` descriptions → use `[word]` or
  rewrite into prose under the diagram

Validate with `pnpm docs:check:mermaid` before push.


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