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

Before cutover, v1 authority stays on `main` and v2 authority stays on
`v2`. V2 ADRs, normative specifications, and architecture handoffs land
and pass their review gates on `v2`; they do not require a duplicate
main-branch copy.

## Constitution (v2 design law; v1 is not retrofitted)

1. Endpoints | control plane + storage | data plane. Registry, Router,
   Ledger, and one `moltzapd` per named local profile slot are independent
   processes. The local daemon-to-runtime MCP boundary is not a network plane.
2. Everything interpretive lives at endpoints, in their local Harness
   subsystems. The Router has no app principals, manifests, hooks, callbacks,
   conversations, tasks, norms, or policy.
3. Explicit management and agent-runtime operations use the daemon's
   loopback MCP surface. One listener exposes registration at
   `/register/mcp` and registered operations at `/mcp`; `moltzapd`, not
   the MCP client, speaks the network protocols. There is no bespoke CLI
   authority.
4. One stack, eight layers, two regions. Communication: L1 identity,
   L2 equivocation-free globally ordered multicast of opaque messages to
   explicit AgentIds, L3 conversations/reliability/protocols/committed
   actions, L4 tasks and norms. Trust: L5 personal trust, L6 social
   oversight, L7 independent institution services, L8 governance.
   Guarantees flow up; configuration flows down.
5. L1 and L7 are separate trust domains. The identity Registry returns
   complete immutable AgentCards and never carries institutional policy.
   Router and Ledger never query L7.
6. L2 owns no ConversationId, membership, transaction, persistence,
   replay, or recovery semantics. Those are L3 endpoint responsibilities.
   The data plane remains content-blind, preserving the possibility of
   end-to-end encryption without requiring it.
7. Endpoints decide whether an action is valid and produce its complete
   certificate. The Ledger validates the closed certificate format,
   bindings, exact signer set, and signatures mechanically; it does not
   evaluate grant precedence, content, task legality, or policy.
8. Storage is atomic commit: one canonical record becomes durably
   readable to every fixed member or to none, and acknowledgment implies
   commitment. The store does not maintain per-recipient record copies.
9. Gate 1 assumes one correct non-equivocating Registry, one correct
   non-equivocating Router, one correct durable Ledger, and potentially
   Byzantine endpoints. Service availability affects progress; safety and
   liveness claims state those assumptions separately.
10. Interfaces and repository-native decisions precede implementation.
    Guarantees, not mechanisms, govern normative specs; questions remain
    questions absent evidence or a recorded decision; keep the boring
    parts boring.

Canonical text, the Gate 1 profile, and the remaining open-question
register live in `v2/VISION.md`. The accepted decision manifest and its
traceability table live in
`docs/decisions/20260728-gate-1-architecture-freeze.md`.

## Issues

`v2` = input to the v2 track. `wontfix-v2` = dies with retired v1
machinery; fixing it on main stays a v1 call. Epic #755 owns bootstrap
and debt-zero work.

## Architecture decision records

`docs/decisions/` is the durable ADR log. Its `README.md` is the
human-maintained index; ADR frontmatter is authoritative for status.

### Admission and scope

- Admission is maintainer-gated. Do not add an ADR until the maintainer
  has decided that the choice belongs in the log.
- Record durable choices about architecture boundaries, public
  interfaces or wire contracts, guarantees and fault assumptions,
  persistence or recovery, security or trust, package ownership,
  compatibility, or the replacement of an accepted decision.
- Do not admit an ADR whose Decision Outcome is an unresolved question,
  a proposal awaiting a decision, a temporary implementation plan, or a
  routine local detail. A decided outcome may identify questions it
  deliberately leaves open; keep those questions in the governing
  vision/spec and proposals in their designated draft location.

### Record shape

- Name records `YYYYMMDD-short-kebab-title.md`. The frontmatter `date`
  must match the filename date. Multiple records may share a date;
  never introduce sequence numbers.
- Every record has MADR-minimal frontmatter with `status`, `date`, and
  `decision-makers`. Status is exactly `accepted`,
  `partially-superseded`, or `superseded`.
- `accepted` means the Decision Outcome is current.
  `partially-superseded` means only the scope explicitly retained in
  `Supersession` is current. `superseded` means the record is historical
  only.
- Every new record contains `Context and Problem Statement`, `Decision
  Outcome`, and `Consequences`. Older admitted records retain their
  historical body shape. State the binding outcome in present tense and
  describe guarantees separately from mechanisms.
- Immediately below its title, every record visibly links
  `Decision provenance` to at least one compacted session trajectory in
  the repository-wide, non-normative `docs/decision-evidence/` area.
- A partially superseded or superseded record also has
  `superseded-by` naming its primary replacement and a visible
  `Supersession` section immediately after the provenance link. That
  section says precisely what remains current, what was replaced, and
  where the current contract lives.

### Decision provenance

- A compacted trajectory is a source-faithful event ledger, never
  normative authority or a reconstructed explanation. One trajectory
  may support several ADRs; link the relevant stable heading rather
  than duplicating it.
- Every retained event identifies the source system, source session,
  native message or event locator, enclosing turn and parent locator
  when the source provides them, UTC timestamp, stored actor role, and
  a literal excerpt. If a source has no message ID, cite the session,
  turn, event kind, and exact timestamp instead of inventing one.
  Preserve spelling, punctuation, hedges, questions, and option labels.
  Mark every omission or normalization; never silently strengthen or
  repair the source.
- Include the public agent question or options when needed to interpret
  a terse human reply. A reply such as `A`, `B`, `1`, `sure`, or
  `okay` has no meaning beyond the directly preceding retained prompt.
  Record agent proposals as agent events and repository changes as
  separate mechanical events.
- Do not infer motives, rationale, confidence, urgency, causality, or
  mental state. Record uncertainty, time pressure, reasons,
  alternatives, reversals, deferrals, and revisit triggers only when a
  cited source event states them. Absence is a source gap, not an
  invitation to explain the human.
- `decision-makers` names the humans accountable for the call. The
  field does not prove that the session account authored every rationale
  in the ADR. The named decision-maker reviews the event linkage when
  admitting the ADR. Agents remain recommenders, questioners, or
  scribes unless a human explicitly delegates decision authority.
- Compact the material public exchange, not a raw transcript export or
  hidden model reasoning. Do not commit secrets, personal data, private
  research, system prompts, irrelevant third-party text, or
  authentication-bound session URLs as the sole evidence. State
  omissions and redactions.
- If an original session cannot be located, record a source-gap report.
  Git commits and ADR prose may establish repository history, but they
  do not reconstruct a missing conversation or human rationale.
  Preserve later source discoveries as dated corrections.
- Treat an ADR as a revisable human choice rather than self-justifying
  prose. A recorded provisional call or source gap is a reason to ask
  the named human to reconsider; it is not permission for an agent to
  ignore a current outcome.

### Lifecycle and landing

- Never delete, renumber, or silently rewrite an admitted decision.
  Preserve its historical reasoning; change its status and add
  supersession context, or admit a replacement ADR.
- Land a decision atomically with any required normative spec changes,
  affected architecture pages, prior-record supersession, and
  `docs/decisions/README.md` index row.
- When a decision belongs to a decision manifest, update its stable
  trace row, normative owner, acceptance-evidence family, and any
  explicit deferral in the same change.
- A cold reader must be able to determine the current decision, its
  scope and assumptions, its normative owner, its consequences, and
  every record it replaces without consulting chat, issues, or private
  agent state.
- The index is reviewed Markdown, not generated authority. Existing
  formatting, link, Mermaid, and generated-document checks cover
  mechanical integrity; semantic consistency, lineage, and
  traceability require review.

### Blind teammate review gate

After any admitted ADR is added or changed—including its status,
outcome, consequences, supersession, provenance link, normative owner,
or manifest trace—the exact candidate revision must pass this gate
before landing.

- Freeze the candidate as a commit or reproducible content digest. The
  reviewer is a teammate or fresh agent session that did not author or
  reconcile the change and receives no inherited conversation,
  compaction, memory, private state, or earlier blind-review output.
- Give the reviewer only the candidate repository root and the fixed
  questions below. Do not supply a design summary, diff tour, ADR or
  file pointer, search term, expected answer, or out-of-band index.
  Normal repository navigation, history, search, and discovery of the
  checked-in decision index are allowed. Earlier `*-cold-review.md`
  records and invalid-review records remain checked in for auditability,
  but they are quarantined inputs: the reviewer must not open, read, or
  search their contents during the run. Merely seeing an artifact path
  in a directory listing or history is allowed. If a command returns an
  answer or verdict from one of those quarantined records, invalidate
  the run immediately. Engineering-review evidence recorded in the
  candidate ADRs or trajectories is not a quarantined blind-review
  record.
- Do not coach the reviewer or answer questions during the run.
  `Not discoverable` is a valid result. A material author hint
  invalidates the run. Bound the review to one uninterrupted fresh-agent
  context or 45 minutes for a human so archaeology cannot hide poor
  organization.

Ask, verbatim:

1. What decision does this candidate make current, what problem does it
   resolve, and which statements are binding versus context or
   non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched,
   and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers
   are affected, and under what fault, trust, safety, liveness, and
   compatibility assumptions?
4. Which humans are named as decision-makers, which source events does
   the compacted trajectory cite for their calls, alternatives,
   reversals, and deferrals, and what source gaps does it explicitly
   record? Report only what the event ledger states; do not infer
   motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or
   broken lineage elsewhere in the repository. Resolve it using the
   authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing?
   List every missing link or unresolved choice and classify each as a
   deliberate deferral or an accidental gap.

Record the candidate identity, exact prompt, reviewer identity and
isolation attestation, duration, unedited answers, independently
discovered paths/headings, discovery trail, author interventions,
per-question verdicts, blockers, and overall result under
`docs/decision-evidence/`.

PASS requires all six answers to be accurate and discoverable, with
consistent status, lineage, authority, assumptions, normative ownership,
and source-event attribution. Any wrong or unfindable answer, broken
source locator, unresolved contradiction, invented binding choice, or
need for an author hint is FAIL and blocks landing. A maintainer accepts
the result; reviewer prose is not self-certifying.

After a failure or any semantic ADR, trajectory, authority, spec, trace,
rebase, or conflict-resolution change, freeze a new candidate and use a
different fresh reviewer. Adding only the review artifact or applying
meaning-preserving formatting does not invalidate the reviewed
candidate.

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

- Authority order for v2 is: this agent law and `v2/VISION.md`; current
  ADR outcomes, including explicitly retained portions of
  partially-superseded records; normative `docs/spec/` chapters;
  architecture orientation and execution plans; historical inputs. A
  lower source must not contradict a higher source.
- Before v2 implementation changes, the governing spec and decision
  traceability must be complete. No binding decision may exist only in
  chat, an issue comment, or an agent-private state directory.
- Flow diagrams are Mermaid in JSDoc above the owning symbol;
  generated MODULE.md pages surface them. Change a flow → update its
  diagram in the same PR. Cross-package flows are documented once at
  the canonical owner; elsewhere link by symbol name.
- Mermaid, GitHub-strict: `<br>` not `<br/>`; literal `<` `>` not
  entities; no `;` in `Note` text; no `<br>` or parentheses in participant aliases;
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
