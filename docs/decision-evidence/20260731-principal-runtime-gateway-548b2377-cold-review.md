# Blind teammate review

## Candidate identity

- Commit: `548b2377f3726e0ec0aad7d317b87e924d90b568`
- Tree: `ef25fc200f001b895311f2d77503ae5e5e6a59ab`
- Parent: `6bce95808ae8112206b247702bd86c67d6fcfb3b`
- Branch: `refactor/effect-native-evals`
- Subject: `fix(evals): observe NanoClaw principal output`
- Candidate remained clean and unchanged throughout the review.
- Start: `2026-07-31T00:43:29Z`
- End: `2026-07-31T00:50:52Z`
- Duration: 7 minutes 23 seconds.

Reviewer: Codex fresh sub-agent `/root/blind_adr_review_548b2377`.

Isolation attestation: I received only the fixed review prompt and normal
repository instructions. I had no inherited author conversation, compaction,
private state, design summary, diff tour, file pointer, search term, expected
answer, author help, or earlier review result. A directory/stat listing exposed
the filename
`docs/decision-evidence/20260729-principal-runtime-gateway-931dd06a-invalid-review.md`;
this is permitted by the quarantine rule. I did not open, read, or search that
file or any `*-cold-review.md` file. No command returned content, an answer, or
a verdict from a quarantined record.

Author interventions: none.

## Exact prompt

```text
Repository root: /Users/tapanc/moltzap/.claude/worktrees/rebase-correctness-simplify

Perform the repository's blind teammate review gate in one uninterrupted fresh context. You have no inherited conversation, compaction, memory, private state, earlier review output, design summary, diff tour, file pointer, search term, expected answer, or author help. Do not open, read, or search the contents of any prior `*-cold-review.md` or invalid-review record; merely seeing an artifact path in a listing or history is allowed. If any command returns an answer or verdict from one of those quarantined records, stop and invalidate the run. Navigate the candidate repository normally and answer these questions verbatim:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Return the candidate commit identity, reviewer identity and isolation attestation, start/end UTC timestamps and duration, the exact prompt, unedited answers, independently discovered paths/headings, discovery trail, author interventions, per-question verdicts, blockers, and overall PASS/FAIL. PASS only if all six answers are accurate and discoverable with consistent status, lineage, authority, assumptions, normative ownership, and source-event attribution. Do not edit files.
```

## Unedited answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The current decision is the accepted ADR
`docs/decisions/20260729-principal-io-uses-runtime-gateways.md`, “Principal I/O
uses runtime-native gateways.”

It resolves a boundary error in the first code-first evaluation design. That
design made the evaluation controller a synthetic MoltZap participant, allowing
it to create social workspace, send prompts, and select replies on behalf of the
autonomous agent. This tested routing but not the real principal-to-agent
boundary and introduced `replyToId` as a universal correlation mechanism.

The current outcome is:

- Principals drive autonomous agents only through each runtime’s native
  gateway.
- MoltZap carries agent-to-agent social traffic.
- Runtime acquisition exposes the exact gateway and termination Effect.
- The keyed roster preserves each runtime’s exact gateway type alongside its
  router-issued `AgentHandle`.
- Code agents use their customer-defined in-process Effect API directly as
  their gateway; the simulator does not add a generic queue, mailbox, command
  bus, or second request protocol.
- Runtime adapters remain evaluation/customer policy, not simulator-kernel
  unions.
- Behavioral evaluations do not create synthetic principals, social workspace,
  identifiers, or messages on an agent’s behalf.
- Gateway evidence and router/social evidence remain separate claims.
- NanoClaw output is an uncorrelated stream: it may be observed and recorded
  independently, but no frame is treated as the response to an instruction.
- `replyToId` is removed end to end.
- The earlier synthetic-peer sweep is network/channel diagnostic evidence, not
  behavioral acceptance evidence.
- Behavioral acceptance uses runtime-native principal input, autonomous social
  action, the production router, combined gateway/ledger evidence, and at least
  one mixed process/code society.

The binding material is the accepted ADR’s scope, Decision Outcome, and
Normative Owners, together with the explicitly retained portions of the two
partially superseded ADRs. The current source ownership named by the ADR is also
discoverable in the implementation.

The Context and Problem Statement explains the problem. Consequences and
historical implementation plans explain effects and history rather than
independently defining guarantees. The linked trajectories are explicitly
non-normative evidence. The decision index says that historical bodies of
partially superseded records may retain old vocabulary and that their visible
Supersession sections and accepted replacement govern.

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It replaces parts of two prior ADRs.

From `20260727-code-first-simulator-kernel.md`, it replaces:

- the claim that the runtime management gateway remains private;
- router-observed authentication as the sole readiness condition;
- the old three-entry-point public package boundary;
- synthetic-endpoint OpenClaw/NanoClaw runs as behavioral acceptance.

It retains:

- the code-first simulator;
- one-package ownership;
- the closed typed event catalog;
- RunLedger evidence;
- one mixed-runtime production router;
- Effect resource boundaries;
- customer-owned scenario and grading policy;
- distinct network identity and runtime lifetime.

From `20260729-effect-native-evaluation-results.md`, it replaces:

- the controlled-endpoint episode model;
- a single-target runtime condition;
- evaluation-created social workspace;
- `EvaluationResponseSelected`;
- prompt-bound selected-response requirements;
- `replyToId` correlation;
- synthetic-peer runs as behavioral acceptance.

It retains:

- runtime provenance;
- total typed run outcomes;
- code-defined case and criterion catalogs;
- deterministic and semantic judging;
- resumable report-local SQLite state;
- Phoenix publication;
- the sixteen case identities, behavioral questions, and slice coverage as
  initial intent.

It leaves experiment-controlled endpoints available for diagnostics, workloads,
probes, and observation. It leaves Gate 1’s v2 package map, process boundaries,
specifications, and zero-v1-import rule untouched. It also leaves
restart/replacement and several universal gateway semantics outside v0.

The current normative contract lives in:

- `docs/decisions/20260729-principal-io-uses-runtime-gateways.md`;
- the Supersession sections of the two partially superseded ADRs;
- the source owners listed under the accepted ADR’s Normative Owners.

The implementation owners are `packages/simulator/src/runtime/runtime.ts`,
`packages/simulator/src/runtime/roster.ts`, the runtime-specific gateway
folders, `packages/evals`, the simulator kernel/router/ledger, and the v1
protocol/server/client/channel packages for mechanical `replyToId` removal.

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Return `RunningAgent<Gateway>` with the exact gateway and termination Effect.
- Construct `StartedAgent<Name, Gateway>` by adding the router-issued agent
  handle.
- Preserve literal roster keys and exact gateway types.
- Publish runtime contracts and shipped gateway implementations through
  `@moltzap/simulator/runtime`.
- Keep runtime-native readiness, provisioning, lifetime, and teardown scoped to
  the runtime implementation.
- Let customer/evaluation adapters understand concrete gateways.
- Drive autonomous agents through gateways and require all social actions to
  use the production MoltZap client and router.
- Declare gateway and social event classes before run allocation.
- Corroborate social testimony with exact router commits.
- Keep native gateway identifiers only in runtime-specific schemas.
- Treat NanoClaw outputs as independently observed, uncorrelated frames.
- Remove `replyToId` from protocol, server, persistence, client, channel,
  simulator, and evaluation surfaces.
- Preserve operational failures as typed evidence rather than behavioral
  verdicts.

An implementer must avoid:

- a simulator-wide gateway union;
- a universal command/response/session/model language;
- a synthetic `eval-sender`;
- precreating tasks, conversations, or social message identities for the
  target;
- sending social traffic on an autonomous agent’s behalf;
- bypassing the router for code agents;
- treating gateway output as proof of social behavior;
- treating router persistence as proof that the principal instruction was
  consumed;
- inventing universal gateway correlation or atomic gateway-call/ledger-append
  semantics;
- consuming NanoClaw’s “next frame” as an instruction response;
- compatibility shims or migrations for `replyToId`;
- unrelated behavioral channel workarounds intended to force passing
  evaluations.

Affected consumers are the v1 simulator, private eval application, runtime
implementations, protocol, server, client, OpenClaw/NanoClaw channel fallout,
development databases, and evaluation operators. V2 is explicitly not amended
by this ADR.

Trust and fault assumptions:

- Gateway adapters and their event writers are trusted evaluation instruments.
- Simulator ledgers are canonical evidence.
- Semantic judges are fallible testimony.
- Phoenix is a replaceable materialized view.
- Autonomous agents and their processes may ignore instructions, misbehave,
  terminate, or become unavailable.
- Missing, invalid, or incomplete evidence is an operational/evidence failure
  and never a behavioral pass.
- A bounded, acknowledged instruction with complete evidence but no social
  action is observed non-action and may be graded failed or undecided.
- Gateway, model-provider, router, and result-service availability affects
  progress and operational outcomes, not behavioral truth.
- No new v2 Byzantine-service claim is introduced.

Compatibility:

- `replyToId` removal is deliberately breaking.
- Existing development databases using the old schema must be rebuilt.
- There is no shadow field, startup `ALTER TABLE`, compatibility decoder, or
  one-off migration runner.
- Landed persisted event-shape changes require a new versioned event tag.
- Restart, replacement, rebinding, fencing, and offline-delivery guarantees
  remain outside v0.

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The three relevant ADR frontmatters name one accountable human: Tapan Chugh. The
trajectories explicitly state that stored `user` actor roles do not
independently authenticate the person controlling an account.

The current gateway trajectory cites Codex session
`019fa613-7f9a-7103-99b0-a42fda0754de`:

- Turn `39d5505f-efa9-417d-b97f-14af5a270f73`, user event
  `2026-07-30T02:08:47.726Z`, attachment
  `f4eee480-6d7d-4bb2-b8e7-0d6c57e60b6e`, records the system boundary,
  runtime contract, scenario ownership, evidence/correlation boundary,
  `replyToId` removal, diagnostic reclassification, and implementation order.
- Turn `019fa7af-1431-7c52-897e-e9371a23984a`, user event
  `2026-07-28T07:44:58.076Z`, states replacement and restart are stretch goals,
  not v0 scope.
- Turn `abe428a0-3b20-4730-8b40-58f34b290145`, user event
  `2026-07-28T21:21:18.802Z`, calls for compatibility API cleanup.
- Result-management events request an existing evaluation-results library,
  visible results, consideration of Genkit, Effect SQL, and avoidance of manual
  machinery.
- Turn `39d5505f-efa9-417d-b97f-14af5a270f73`, user event
  `2026-07-30T03:58:24.275Z`, questions a draft generic
  `Queue<CodeAgentCommand>` because OpenClaw and NanoClaw already have principal
  gateways.

The evaluation-results trajectory cites:

- User events requesting disclosure/group/injection/conversation-awareness
  coverage, a full LLM judge, an existing result platform, visible results, and
  Genkit consideration.
- Assistant event `2026-07-29T19:00:18.265Z`, comparing Phoenix, Braintrust,
  Opik, Promptfoo, Genkit, and MLflow and recommending Phoenix.
- Tool-mediated answer `2026-07-29T19:03:52.934Z`, selecting Phoenix local and
  an explicit publish step.
- Tool-mediated answer `2026-07-29T19:10:24.665Z`, explicitly saying “revert
  previous decision to merge publish with grading,” and selecting
  external-service-only lifecycle ownership.
- Tool-mediated answer `2026-07-29T19:12:34.394Z`, selecting a generated report
  artifact.
- Tool-mediated answer `2026-07-29T19:25:59.185Z`, selecting executable prompts
  and checkpointing after every attempt.
- Tool-mediated answer `2026-07-29T19:28:05.770Z`, requiring native runtime
  configurations rather than normalization.
- Tool-mediated answers `2026-07-29T19:52:42.493Z`, selecting runtime-contract
  ownership and resume-pending, while stating results do not belong in the
  queried simulator evidence boundary.
- User event `2026-07-29T16:44:02.345Z`, stating NanoClaw failure should remain
  failure and be documented.
- Assistant plan `2026-07-29T20:08:17.572Z`, followed by user messages
  `2026-07-29T20:13:28.642Z` and `2026-07-29T20:13:50.017Z` saying to implement
  the plan and make it the goal.

The retained code-first trajectory cites user events for code-first customer
policy, removing YAML-imposed unions, declaring event classes upfront,
simplifying through Effect, mixed real/code societies, customer-owned
termination policy, “ledger” vocabulary, Effect services, branded SQL types,
Effect SQL, and one simulator package. The runtime-termination answer follows a
retained assistant question, so the terse approval remains interpretable.

Explicit source gaps include:

- No separate message ID or parent locator for the cited source format.
- The gateway handoff does not identify preceding events from which it was
  assembled.
- No independent human rationale is recorded for every detailed contract or
  implementation choice.
- The handoff does not choose concrete OpenClaw/NanoClaw commands, transports,
  session IDs, or response shapes.
- It does not name the composite roster-entry type or router-handle property.
- It permits provisioning without separately assigning its mechanism.
- It does not prescribe universal event payloads or content-retention policy.
- It does not prescribe migration mechanics or historical event-tag treatment.
- The evaluation request does not prescribe a relational schema or concurrency
  mechanism.
- Assistant-authored platform comparisons and plan details remain attributed to
  the assistant; later approval does not reattribute their authorship.
- Private instructions, hidden reasoning, irrelevant tool output, environment
  diagnostics, and credentials are omitted.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest apparent contradiction is inside the historical bodies of the
two partially superseded ADRs: they still say gateways are private, router
authentication alone defines readiness, only three package entry points exist,
selected responses require old correlation, and endpoint-driven evaluations
represent acceptance.

This is resolved by repository authority and explicit lineage:

1. Root agent law defines status semantics.
2. `docs/decisions/README.md` says only the visible retained scope of a
   partially superseded record remains current.
3. Both older ADRs have matching `partially-superseded` frontmatter,
   `superseded-by`, visible Supersession sections, and links to the accepted
   gateway ADR.
4. The accepted replacement and current source surfaces govern.

Two v2 historical inputs still mention `replyToId`; they are lower-authority
historical audits, while the accepted ADR is explicitly scoped to v1 and
explicitly leaves v2 unchanged.

The pending `v2/inputs/simulator-handoff-20260728.md` still names the older
candidate lineage and obsolete `measure:roster`/`measure:live` target rows. It
is not current acceptance evidence: its status is `pending upstream landing`,
its SHA is unset, and `docs/architecture/first-implementation.md` says the exact
landed SHA, commands, results, and evidence are filled only after Phase 1 lands.
Those rows must be refreshed before the handoff can become `verified`; until
then they deliberately block the v2 port. They do not override or contradict
the current v1 decision.

No unresolved current normative contradiction or broken source link was found.

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Yes. The accepted ADR identifies the contract, forbidden shortcuts, evidence
semantics, compatibility behavior, package organization, and exact normative
owners. The source implements the named generic types and package export,
preserves exact gateway types, supplies runtime-specific gateways, separates
gateway/social evidence, observes NanoClaw output independently, uses
report-local Effect SQL, and removes `replyToId`.

Deliberate deferrals and delegated choices:

- Restart, replacement, rebinding, fencing, and offline delivery.
- Cross-runtime gateway normalization and correlation.
- Universal gateway retry, idempotency, streaming, authentication, and session
  semantics.
- Concrete gateway commands, transports, native IDs, and response shapes;
  runtime adapters own them.
- Concrete skill provisioning; runtime implementations own it.
- Gateway event payloads and content-retention policy; evaluation/customer
  event catalogs own them.
- Task/conversation lifecycle evidence not exposed by the production router; a
  future production owner must supply it if needed.
- Durable database-upgrade migrations; current v1 databases are rebuilt.
- Exact Phoenix assessment conflict detection until an official read API
  exists.
- Behavioral channel changes intended to improve scores.
- V2 adoption until the main-branch source handoff is verified.
- Selectable NanoClaw principal output until its native gateway supplies
  correlation/terminal semantics.

Provenance gaps are explicitly recorded rather than silently filled and do not
require an implementer to invent a contract.

One pending cleanup is discoverable in the v2 handoff template: its old
measurement target names must be replaced with the exact landed candidate’s
current verification commands before changing that manifest to `verified`.
This is outside the current v1 implementation and already blocked by the
manifest’s pending status. It is not an accidental gap in the accepted gateway
contract.

No author hint or chat-only choice is needed to implement the current decision.

## Independently discovered paths and headings

- `docs/decisions/README.md` → “Canonical reading guidance”, “Records”
- `docs/decisions/20260729-principal-io-uses-runtime-gateways.md` → “Decision
  Outcome”, “Normative Owners”
- `docs/decisions/20260729-effect-native-evaluation-results.md` →
  “Supersession”
- `docs/decisions/20260727-code-first-simulator-kernel.md` → “Supersession”
- `docs/decision-evidence/README.md` → quarantine and event-ledger rules
- `docs/decision-evidence/20260729-principal-runtime-gateway-trajectory.md` →
  “Principal I/O uses each runtime gateway”
- `docs/decision-evidence/20260729-effect-native-evaluation-results-trajectory.md`
  → “Evaluation runs produce typed reports published to Phoenix”
- `docs/decision-evidence/20260727-code-first-simulator-trajectory.md` → “The
  simulator is code-first with a closed event catalog”
- `packages/simulator/src/runtime/runtime.ts` → `RunningAgent`
- `packages/simulator/src/runtime/roster.ts` → `StartedAgent`, `StartedAgents`
- `packages/simulator/src/runtime.ts` → public runtime facade
- `packages/simulator/src/runtime/effect.ts` → `effectRuntime`
- `packages/evals/src/principal.ts` → `PrincipalDriver`, OpenClaw/NanoClaw
  adapters
- `packages/evals/src/events.ts` → gateway and router-corroborated social
  evidence
- `packages/evals/src/execution.ts` → independent principal observation and
  unsupported selectable output
- `packages/evals/src/results.ts` → report-local Effect SQL transactions
- `packages/evals/src/phoenix.ts` → `PhoenixPublisher`
- `packages/evals/project.json` → current Nx targets
- `docs/simulator/overview.mdx` and `docs/simulator/grading.mdx`
- `v2/inputs/simulator-handoff-20260728.md` → pending provenance gate
- `docs/architecture/first-implementation.md` → Phase 1 handoff sequence

## Discovery trail

1. Captured UTC start time, HEAD, status, branch, commit metadata, and
   non-quarantined repository file inventory.
2. Inspected candidate and parent stats, recent history, merge bases, and
   changed filenames.
3. Discovered the decision index, relevant ADR statuses, and linked
   trajectories without opening any review artifact.
4. Read the three current/partially superseded ADRs and their three source-event
   ledgers.
5. Searched current code and non-quarantined docs for `replyToId`, synthetic
   principals, selected-response vocabulary, native gateways, evidence
   boundaries, and behavioral-acceptance claims.
6. Inspected the exact runtime, roster, gateway-adapter, evidence, report,
   Phoenix, and package-export owners.
7. Traced the v2 scope boundary and pending source-handoff process.
8. Verified frontmatter status, supersession metadata, provenance anchors, final
   HEAD/tree, and clean worktree.

No source files were edited. No tests were run; this was a read-only
discoverability and semantic-lineage review.

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 | PASS — current decision and binding/non-normative boundary are discoverable |
| 2 | PASS — retained, replaced, and untouched scopes have explicit lineage |
| 3 | PASS — implementation requirements, affected consumers, and assumptions are stated and implemented |
| 4 | PASS — accountable human, source events, assistant proposals, reversals, deferrals, and source gaps are attributed without inference |
| 5 | PASS — apparent contradictions resolve through explicit supersession and authority; pending v2 handoff is not current evidence |
| 6 | PASS — implementation is possible without chat; remaining choices are explicit deferrals or delegated ownership |

Blockers: none for landing this candidate. The v2 port remains intentionally
blocked until its separate post-landing handoff is corrected and verified.

Overall result: **PASS**.
