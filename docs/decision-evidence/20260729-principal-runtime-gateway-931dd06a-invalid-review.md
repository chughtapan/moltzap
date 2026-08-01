# Principal runtime gateway invalid blind review

- Candidate: `931dd06a8e6d15fb8bc6dbc5e95467b9d2d220e2`
- Candidate root:
  `/tmp/moltzap-blind-931dd06a.4Qq7U5/repo`
- Reviewer: `/root/blind_gateway_review`
- Visible model description: `Codex, an agent based on GPT-5`
- Exact deployed model and reasoning setting: not visible to the reviewer
- Duration: not exposed to the reviewer
- Author interventions during the substantive review: initial prompt only
- Quarantined review contents encountered: none
- Result: **INVALID**

The reviewer called `collaboration.list_agents({})` before repository analysis.
That exposed completed private summaries from
`/root/gateway_provenance_audit` and `/root/original_adr_provenance`.
Although neither summary was a quarantined review artifact and the author did
not intervene, the exposure violates the fresh-agent isolation requirement.
The answers remain below, unedited, for auditability and may inform repairs,
but they do not satisfy the landing gate.

## Exact prompt

```text
Candidate repository root: /tmp/moltzap-blind-931dd06a.4Qq7U5/repo

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
```

## Unedited answers

Candidate `931dd06a8e6d15fb8bc6dbc5e95467b9d2d220e2`

Overall result: **FAIL — unresolved contract contradiction and stale implementation guidance block landing.**

## 1. Current decision and authority

`docs/decisions/20260729-principal-io-uses-runtime-gateways.md` makes this current for the v1/Main Phase 1 baseline:

- Principals and evaluation programs control each autonomous agent through its runtime-native gateway.
- Only agents generate MoltZap social traffic. Evaluations cannot impersonate principals with controlled endpoints, create social workspaces for agents, or send on their behalf.
- Code and process-backed agents share the production protocol/router without callback shortcuts.
- Runtime acquisition returns an exact gateway plus termination; the keyed roster exposes `agent`, `gateway`, and `termination` without a cross-runtime gateway union.
- Gateway and router evidence remain distinct.
- `replyToId` is removed end-to-end as a breaking change.
- The earlier 32-run sweep and shared-conversation probe become network/channel diagnostics, not behavioral acceptance evidence.
- Behavioral evaluations are rebuilt around gateway input, autonomous social action, production-router commits, combined evidence, and at least one mixed process/code society.

It resolves a measurement-boundary error: the old harness created conversations and prompts as a synthetic MoltZap peer, thereby performing the behavior it purported to measure. `replyToId` was then used to recover causality from that artificial arrangement.

Binding material is the accepted ADR’s scope, `Decision Outcome`, and `Normative Owners`, together with the explicit retained portions of partially superseded records. The TypeScript interfaces appear inside `Decision Outcome` and are presented as the current interface, not illustrative pseudocode.

`Context and Problem Statement` and `Consequences` explain the decision; they add no independent authority beyond what they restate. `docs/decision-evidence/20260729-principal-runtime-gateway-trajectory.md`, its source gaps, mechanical repository notes, prior diagnostic results, and `docs/decisions/README.md` are non-normative. ADR frontmatter, not the index, determines status.

## 2. Supersession and current contract

The decision partially supersedes two records:

- `20260727-code-first-simulator-kernel.md` retains the code-first TypeScript/Effect simulator, one package, closed event catalog, ledger, mixed-runtime router, Effect resource model, customer-owned policy, and separation of network identity from process lifetime. It replaces private-only management gateways, router-authentication-only readiness, synthetic endpoints as principal interfaces, and their use as behavioral acceptance.
- `20260729-effect-native-evaluation-results.md` retains runtime provenance, total outcomes, the code-defined case/criterion catalog, semantic grading, resumable reports, Phoenix publication, and the sixteen existing case identities, descriptions, criteria, rubrics, and slices as behavioral intent. It replaces controlled-endpoint episodes, single-target conditions, evaluation-created workspace, `EvaluationResponseSelected`, prompt-bound response selection, `replyToId` correlation, and synthetic-peer behavioral classification.

Experiment-controlled endpoints remain valid for probes, workloads, traffic generation, and observation. The prior 32-run report and mixed probe remain historical diagnostics.

The current principal/gateway contract lives in `20260729-principal-io-uses-runtime-gateways.md`. The retained contracts live only in the explicit `Supersession` sections and unaffected outcome portions of the two partially superseded ADRs.

Gate 1 v2 law, package boundaries, fault model, and normative specifications are explicitly untouched. The v2 contract remains `AGENTS.md`, `v2/VISION.md`, the Gate 1 ADR manifest, and `docs/spec/`; the pending simulator handoff remains pending.

## 3. Implementation obligations and assumptions

An implementer must:

- Update `runtime/runtime.ts` so acquisition returns `RunningAgent<Gateway>`.
- Thread each exact gateway type through `AgentRuntime`, heterogeneous roster inference, and `runtime/roster.ts`.
- Make the roster expose `StartedAgent<Name, Gateway>` rather than only `AgentHandle`.
- Update `kernel/runtimes.ts` to preserve the full started value.
- Make OpenClaw, NanoClaw, Effect, scripted, and customer runtime implementations expose native gateways within the runtime Scope.
- Treat readiness as both gateway readiness and usability of configured MoltZap capabilities.
- Keep runtime-specific gateway APIs and skill provisioning outside simulator-core interpretation.
- Rebuild evaluation conditions as complete rosters with gateway adapters and exact predeclared gateway evidence.
- Grade validated gateway input/output together with lifecycle and durable router evidence.
- Remove synthetic episode construction, old response-selection evidence, and prompt correlation.
- Remove `replyToId` from protocol schemas, server validation/storage, clients, CLI/channel types, simulator events, and evaluation grading.
- Add a forward database migration, stop current readers/writers accepting the field, avoid a shadow decoder, and version any changed landed event shape.
- Regenerate affected generated documentation and tests.
- Preserve report, resume, judge, and Phoenix boundaries while changing their evidence projection.

It must avoid:

- Principal-shaped MoltZap participants.
- Evaluation-created tasks/conversations or preallocated social identifiers.
- Sending social messages for agents.
- Code-agent callback shortcuts.
- Treating gateway evidence as proof of agent consumption or compliance.
- Treating router evidence as gateway evidence, or vice versa.
- Fabricating task/conversation lifecycle events.
- Turning missing evidence into observed non-action or a behavioral pass.
- Behavioral channel changes intended to improve scores.
- Any v2 import or normative-spec change under this ADR.

Explicit trust/fault assumptions are:

- Gateway adapters and their event writers are trusted evaluation instruments.
- Autonomous agents/runtime processes may ignore instructions, misbehave, terminate, or become unavailable.
- The retained evaluation ADR treats the simulator ledger as canonical, semantic-judge output as fallible testimony, transcripts as validated untrusted projections, and Phoenix as a replaceable materialized view.
- Gateway, model-provider, router, and results-service unavailability affects progress and operational outcomes, not behavioral truth.
- Missing, invalid, or incomplete required evidence is an operational/evidence failure.
- An adapter-acknowledged bounded instruction with complete observations but no social action is observed non-action, which case policy may grade `failed` or `undecided`.
- There is no universal atomic transaction between a gateway call and ledger append.
- No restart, replacement, rebinding, fencing, offline delivery, universal retry, idempotency, streaming, authentication, session, normalization, or cross-runtime correlation guarantee is made.
- The `replyToId` change intentionally breaks v1 consumers; there is no compatibility decoder. Landed historical migrations remain immutable, while unlanded local ledgers/tags are not commitments.

The ADR does not state a separate Byzantine/correctness model for the v1 router, ledger, or native gateway. The Gate 1 v2 fault envelope must not be imported into this v1 decision.

## 4. Decision-makers and event ledger

All three relevant ADRs name one accountable human: **Tapan Chugh**. The gateway trajectory itself identifies stored events only by actor role `user`; it does not authenticate that role as Tapan.

The principal-gateway trajectory cites:

- Primary attached handoff: Codex session `019fa613-7f9a-7103-99b0-a42fda0754de`, turn `39d5505f-efa9-417d-b97f-14af5a270f73`, stored `user` message event at `2026-07-30T02:08:47.726Z`; attachment `f4eee480-6d7d-4bb2-b8e7-0d6c57e60b6e/pasted-text-1.txt`, SHA-256 `23a57ba9d5b83e186006dcfa43960e70d734fec3b3cf3fc25f2be98008b71622`.
  - Entries 1–6 state the gateway boundary, proposed runtime result, exact keyed gateway preservation, scenario prohibitions, gateway-native correlation, `replyToId` removal, sweep reclassification, rebuilt acceptance shape, and ADR-before-code ordering.
  - The attachment rejects the synthetic-peer model, simulator-wide gateway union, universal correlation identifier, and code-agent shortcut. It does not preserve an option-selection exchange explaining those alternatives.
- V0 lifecycle deferral: turn `019fa7af-1431-7c52-897e-e9371a23984a`, stored `user` message at `2026-07-28T07:44:58.076Z`: replacement and restart are stretch goals outside v0.
- Compatibility cleanup: turn `abe428a0-3b20-4730-8b40-58f34b290145`, stored `user` message at `2026-07-28T21:21:18.802Z`: existing compatibility API need not be retained.

The old code-first trajectory separately preserves the assistant’s explicit runtime-termination alternatives and the user response “yes let customer policy decide.” The evaluation-results trajectory separately preserves assistant-authored platform alternatives, the user’s Phoenix/explicit-publish selections, the explicit reversal of merged grading/publication, generated-report handoff, checkpoint/resume choices, native runtime configuration, operational-failure treatment, and approval of the assistant plan. Those are provenance for retained outcomes, not authority for the new gateway boundary.

Explicit gateway-trajectory source gaps are:

- No separate message ID or parent locator.
- The attachment does not identify the earlier conversation events from which it was assembled or give independent rationale for each detail.
- No concrete OpenClaw/NanoClaw gateway APIs, commands, transports, native identifiers, or response shapes.
- The source does not name the composite roster type or agent-handle property; the ADR supplies `StartedAgent` and `.agent`.
- No provisioning mechanism/layer assignment in the source; the ADR assigns it to runtime implementations.
- No universal gateway-event payload or content-retention policy.
- No database migration mechanism or historical event-tag treatment in the source.
- Private instructions, hidden reasoning, irrelevant tool output, environment diagnostics, and credentials are omitted.

One additional provenance defect is not listed as a source gap: the mechanical note says the branch was rebased “at the user’s later request” but supplies no source-event locator for that request.

## 5. Strongest contradiction

The strongest contradiction is EVAL-022:

- The accepted ADR forbids creating an `eval-sender` MoltZap participant.
- The same ADR and the prior ADR’s binding `Supersession` retain all sixteen case descriptions, criteria, and rubrics as current behavioral intent.
- `packages/evals/src/cases.ts → eval022` requires the exact selected answer `eval-sender`.
- `packages/evals/src/episodes.ts → SENDER_NAME` and `directEpisode` establish that fact by creating the now-forbidden synthetic endpoint.

The old episode implementation is lower authority and is plainly stale. However, authority order cannot resolve whether the retained EVAL-022 exact criterion must change or whether a roster-declared autonomous peer named `eval-sender` is exceptionally allowed—the current ADR appears to require both “retain it” and “do not create it.” That requires a maintainer decision and is a landing blocker.

Additional stale lower-authority guidance includes:

- `docs/development/evals.mdx → Evidence flow`
- `docs/development/eval-add-evaluation.mdx → Use the narrowest episode`
- `docs/simulator/grading.mdx → Grade the strongest available evidence`
- `packages/evals/src/README.md`
- `packages/evals/README.md`

These still prescribe controlled endpoints, `EvaluationResponseSelected`, exact `replyToId` correlation, and a single target runtime. The accepted ADR wins, but root `AGENTS.md` requires affected architecture/guidance changes to land atomically.

There is also a persistence mismatch: `packages/server/src/standalone.ts → autoMigrateEffect` skips all schema work when a database already exists, while `core-schema.sql` describes a greenfield/no-migration model. That cannot presently deliver the ADR-required forward removal migration.

## 6. Implementability and unresolved choices

A teammate cannot implement the complete decision without resolving the EVAL-022 contradiction. The generic kernel change is otherwise implementable, but the full behavioral baseline still requires substantial explicitly delegated design.

Deliberate deferrals or owner-delegated choices:

- Concrete OpenClaw, NanoClaw, Effect, scripted, and customer gateway APIs.
- Runtime-specific gateway transport, commands, native identifiers, and response shapes.
- Required skill/capability configuration and runtime-specific readiness checks.
- Complete roster composition and code-agent behavior for each case/condition.
- Exact gateway event classes, payload retention, acknowledgement meaning, and native correlation.
- Case-specific evidence selection and `failed` versus `undecided` policy for observed non-action.
- Separate task/conversation lifecycle evidence; v0 relies on committed messages carrying the IDs.
- Restart, replacement, rebinding, fencing, and offline delivery.
- Cross-runtime normalization/correlation and universal retry, idempotency, streaming, authentication, and session semantics.
- Exact migration mechanism and new event tag spellings, subject to the ADR’s compatibility guarantees.
- Channel behavioral improvements and all v2 handoff/port work.

Accidental gaps:

- The unresolved EVAL-022 retained-rubric versus forbidden-participant conflict.
- Stale evaluation and grading instructions that still teach the replaced architecture.
- No existing forward-migration execution path despite a binding requirement to migrate existing databases.
- No cited event locator for the trajectory’s attributed rebase request.
- The public `AgentRuntime` type-level propagation of `Gateway` is not fully specified: the ADR fixes `RunningAgent` and `StartedAgent`, but not the public generic position/default or concrete built-in gateway types.
- No explicit v1 infrastructure correctness/fault assumption beyond trusted evaluation adapters, canonical-ledger language, and availability effects.

The blocker can be removed by recording whether EVAL-022 retains only its identity-awareness concept, changes its exact expected name, or uses an explicitly permitted autonomous sender. The replacement must then update the catalog/versioned criterion as necessary and synchronize the stale guidance.

## Independently discovered paths and headings

The reviewer discovered:

- `docs/decisions/20260729-principal-io-uses-runtime-gateways.md`
  - `Context and Problem Statement`
  - `Decision Outcome`
  - `One society, two interaction boundaries`
  - `Runtime contract and keyed gateway types`
  - `Scenario ownership`
  - `Typed evidence without universal correlation`
  - `Remove replyToId`
  - `Reclassify and rebuild evaluations`
  - `Normative Owners`
  - `Consequences`
- `docs/decisions/20260729-effect-native-evaluation-results.md`
  - `Supersession`
- `docs/decisions/20260727-code-first-simulator-kernel.md`
  - `Supersession`
- `docs/decisions/README.md`
- all three associated non-quarantined trajectories
- the package and guidance paths named in answers five and six.

## Discovery trail

1. Read root instructions and established the exact clean candidate state with
   `pwd`, `rg --files`, `sed`, `git status`, `git branch`, and `git log`.
2. Used `git diff --name-status origin/main...HEAD` and `git show` to identify
   candidate `931dd06a8e6d15fb8bc6dbc5e95467b9d2d220e2`.
3. Read the current decision, both partially superseded ADRs, the decision
   index, and all three non-quarantined trajectories.
4. Inspected the candidate diff for those decision and trajectory files.
5. Searched for stale architecture and `replyToId` consumers while excluding
   `*-cold-review.md`, invalid-review records, and decision evidence when
   appropriate.
6. Read simulator, protocol, server, client, OpenClaw-channel, and
   NanoClaw-channel package instructions.
7. Traced persistence through `core-schema.sql`, `autoMigrateEffect`,
   `schema-migration.test.ts`, database docs, and generated types.
8. Traced simulator runtime and roster contracts and all built-in runtime
   implementations.
9. Read v2 authority and verified that it remained excluded.
10. Traced the evaluation contract through `cases.ts → eval022`,
    `episodes.ts → SENDER_NAME/directEpisode`, events, CLI, grading, package
    docs, and public guidance.
11. Verified the candidate worktree remained clean. No files were edited and
    no tests or network searches were run.

## Per-question verdicts and blockers

1. Accurate and discoverable, but invalidated by isolation exposure.
2. Accurate and discoverable, but invalidated by isolation exposure.
3. Accurate and discoverable, but invalidated by isolation exposure.
4. Found a missing rebase-request locator, but invalidated by isolation
   exposure.
5. Found the EVAL-022 contradiction, stale guidance, and missing migration
   runner; invalidated by isolation exposure.
6. Reported deliberate deferrals and accidental gaps; invalidated by
   isolation exposure.

The maintainer verdict is **INVALID**, regardless of the reviewer's own
`FAIL` result.
