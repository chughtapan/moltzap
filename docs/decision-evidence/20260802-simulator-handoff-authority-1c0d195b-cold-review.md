# Simulator handoff authority blind review

Candidate: `1c0d195b0431b38532df865b18ad8fd02070f4a2`

No author intervention occurred during the completed review. The post-verdict
follow-up only requested mechanical persistence of the already completed
review; it supplied no design guidance and did not alter the verdict or report.

## Exact review prompt

```text
Candidate repository root: /home/tapanc/moltzap-harness-adr

Do not open, read, or search the contents of any earlier `*-cold-review.md` record or invalid-review record. Merely seeing an artifact path in a listing or history is allowed. If a command returns an answer or verdict from one of those records, stop and declare the run invalid. Work only from the checked-out candidate repository and normal repository navigation/history/search. Do not ask the author for hints.

Answer these questions verbatim:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Also report: reviewer identity and isolation attestation; start/end timestamps and duration; independently discovered paths/headings; discovery trail; whether any author intervention occurred; per-question PASS/FAIL; blockers; overall PASS/FAIL. Preserve your answers unedited.
```

## Verbatim unedited reviewer report

Reviewer report

- Candidate: `1c0d195b0431b38532df865b18ad8fd02070f4a2`
- Parent: `08b8808fc8284ddb32d1c3b3a103678632f8cf8b`
- Root: `/home/tapanc/moltzap-harness-adr`
- Reviewer: Codex fresh sub-agent `/root/blind_handoff_review`
- Isolation attestation: I received only the candidate root, the six fixed questions, and quarantine instructions. I received no design summary, file pointer, expected answer, author explanation, previous review result, or inherited author conversation.
- Quarantine attestation: I saw quarantined artifact filenames in listings/history but did not open, read, or search their contents. No command returned an answer or verdict from one.
- Start: `2026-08-02T04:03:50Z`
- End: `2026-08-02T04:07:10Z`
- Duration: 3 minutes 20 seconds
- Author intervention: None
- Working tree: Clean; candidate is one commit ahead of `origin/v2`.
- Mechanical check: `git diff --check HEAD^ HEAD` passed.

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes an operational reconciliation current; it does not admit a new architecture decision.

It changes the simulator source-handoff entry conditions so that:

- the repository-native architecture freeze must be current on the `v2` track; and
- the simulator source candidate must separately be rebased onto current `main`.

It retains the requirement that the imported source changes be reviewed and landed on `main`. This resolves the stale implication that V2 architecture authority itself must land on `main`, which contradicts the accepted “V2 authority lives with V2” outcome.

The binding authority is:

- `AGENTS.md` and `v2/VISION.md`;
- `docs/decisions/20260729-v2-authority-lives-with-v2.md`;
- the explicitly retained source-gate portions of `docs/decisions/20260728-simulator-is-the-system-driver.md`;
- the retained governance portions and current trace rows of `docs/decisions/20260728-gate-1-architecture-freeze.md`;
- `docs/spec/layer-interfaces.md` for current simulator, testbed, `StackProvider`, and `HarnessClient` ownership; and
- `docs/architecture/first-implementation.md` for source-gate sequencing.

`v2/inputs/simulator-handoff-20260728.md` is evidence and the repository record of gate satisfaction. It does not independently create architecture authority, but its identity fields and checklist are the required proof mechanism selected by the current ADR and trace row G1-DEC-717.

Non-binding material includes ADR context, considered options, mechanisms, consequences, superseded historical bodies, architecture orientation outside its assigned process ownership, and all decision-event trajectories. The manifest’s pending branch names and status describe source provenance; they do not define a new public interface.

Per-question verdict: **PASS**

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Replaced:

- `20260722-spec-lives-on-main.md` is fully superseded. V2 law, ADRs, specifications, and architecture guidance no longer become current first on `main`.
- The original Gate 1 freeze requirement that the freeze itself merge first on `main` is replaced by `20260729-v2-authority-lives-with-v2.md`.
- In the handoff checklist, “freeze landed on main” and “candidate rebased onto that main” are replaced by two independent requirements: freeze current on `v2`, source candidate rebased onto current `main`.

Retained:

- The repository-native authority chain, trace inventory, explicit lineage, contradiction-free gate, and blind-review requirement from the partially superseded freeze ADR.
- Simulator ownership of the kernel, `StackProvider`, runtime roster, EventCatalog, RunLedger, source gate, and testbed/fake Layer split.
- The requirement that the simulator source baseline be fully tracked, constitution-aligned, green, landed on `main`, and identified by an immutable SHA.
- `main` remains the V1 production branch, continues to merge forward into `v2`, and remains the npm publishing branch before cutover.

Separately replaced but correctly reflected by the manifest:

- The simulator ADR’s old `EndpointProfileRef` runtime handoff is replaced by the public `HarnessClient` capability. The candidate manifest already says runtime subjects receive `HarnessClient`.

Left untouched:

- No L1, L2, L3, Harness wire, persistence, trust, safety, or liveness contract changes.
- No change to the six-package DAG, zero-v1-import rule, source-port behavior, production cutover, or publishing policy.
- No change to the rule that V2 never merges back before cutover.

Current contract locations:

- Branch authority: `AGENTS.md` → “Project”; `v2/VISION.md` → “Authority”; `20260729-v2-authority-lives-with-v2.md` → “Binding outcome”.
- Simulator ownership and capability boundaries: `docs/spec/layer-interfaces.md` → “Simulator and testbed” and “StackProvider”.
- Runtime handoff: `docs/spec/harness/client.md`.
- Source-gate sequencing: `docs/architecture/first-implementation.md` → “Gate 1 — immutable simulator source baseline”.
- Gate evidence: `v2/inputs/simulator-handoff-20260728.md`.

Per-question verdict: **PASS**

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

Before porting, an implementer must:

- ensure the architecture freeze is current and reviewed on `v2`;
- rebase the source candidate onto current `main`;
- track every needed simulator, testbed, eval, configuration, fixture, and decision file;
- remove assumptions about conversation-aware L2, Router-owned Transcript, an umbrella server, or testbed-owned production implementations;
- pass non-vacuous build, typecheck, lint, unit, architecture, calibration, and live-evaluation gates without Nx cache;
- land the source on `main`;
- verify the exact clean 40-character landed SHA and immutable CI evidence;
- complete the handoff’s identity, review, artifact-digest, event-catalog, mixed-runtime, and teardown evidence; and
- change the manifest to `verified` through reviewed repository change before consuming the source.

The port must preserve `Simulator.define`, immutable definition evidence, the closed typed EventCatalog, RunLedger/LedgerStorage, scoped runtime/process acquisition, the private lifecycle engine, and attributable diagnostics.

It must adapt v1 contracts to simulator-owned `StackProvider`, public `HarnessClient`, v2-native contracts, a testbed-supplied production Layer, separate Registry/Router/Ledger processes, one `moltzapd` per profile slot, and strict RunLedger/Transcript separation.

It must avoid v1 principals, TaskMasters, leases, hooks, callbacks, legacy protocol types, conversation-aware L2, L2 replay/recovery, public `launchTestbed`, a second simulator engine, testbed-owned production services, YAML/grading DSLs in the portable kernel, and Node/platform mechanics in `simulator`.

Directly affected components are `simulator`, `testbed`, and runtime subjects using `HarnessClient`. Registry, Router, Transcript/Ledger, and Harness are affected only as the black-box system supplied through `StackProvider`. OpenClaw, NanoClaw, and evaluation runtimes remain consumers of public interfaces.

Inherited assumptions remain unchanged:

- endpoints may be Byzantine;
- one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger are assumed;
- a malicious or equivocating Registry is outside the L1 guarantee;
- Registry outage blocks registration and uncached resolution, while pinned cards remain usable;
- Router, Ledger, or required-member unavailability may halt progress without weakening ordering or committed-state safety;
- safety does not depend on timing, while timely progress requires fixed members to act within the 90-second TTL;
- Router replication, Byzantine sequencing, and fork detection are not claimed.

Compatibility remains one-way and explicit: V1 production stays on `main`, code merges forward to `v2`, V2 reimplements behavior without imports from `packages/*`, and the old simulator becomes only a temporary facade or is retired. `HarnessClient` compatibility becomes a bidirectional compile-time check only after both branch-owned exact contracts are admitted; there is no runtime generation negotiation or cross-track implementation import.

Per-question verdict: **PASS**

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The relevant ADRs name **Tapan Chugh** as decision-maker:

- V2 authority;
- simulator system driver;
- Gate 1 architecture freeze;
- the superseded main-owned specification decision; and
- the replacement `HarnessClient` decision.

The candidate manifest itself has no ADR frontmatter and names no separate decision-maker. The commit author is also Tapan Chugh, but commit authorship is not treated as decision authority.

Relevant source events:

- Original main-first outcome: S3 user event UUID `e8ce297e-5a99-4f37-96b0-4bb68b21d274`, `2026-07-23T03:40:52.384Z`, says “change the doctrine; spec l;ives on main.”
- Repository-first freeze:
  - user event, session `019fa633-abe3-7223-8c51-6d061f5c5855`, turn `019faa35-8308-7072-a4dc-7ba8b6ebb85d`, `2026-07-28T19:31:03.576Z`, asks that the entire plan and durable decisions first be updated and reconciled in the repository;
  - assistant event `msg_0a59fc7a75687fd4016a6907a037b4819ba26209dd13bc3652`, `2026-07-28T19:50:26.521Z`, proposes a documentation-first PR on `main`;
  - user event, turn `019faa49-1c6e-7380-95ca-ee2eab6febde`, `2026-07-28T19:52:26.138Z`, replies “go”.
- Simulator source gate:
  - user event, turn `019fa9c1-4907-7a00-878b-994029d0f7a3`, `2026-07-28T17:24:05.630Z`, says the simulator is “stable-ish” and asks to build on it;
  - assistant event `msg_050571577920926d016a68edd0f3008199bdc412c135ac23e3`, `2026-07-28T17:58:43.113Z`, proposes the reproducible, rebased, aligned, tracked, green immutable-SHA baseline;
  - user event, turn `019faa9c-a8f8-72f3-b902-819730297f42`, `2026-07-28T21:23:41.617Z`, challenges the later “simulator/wire-profile source” terminology.
- V2-authority reversal and alternatives:
  - assistant event `msg_0d0c5bdb13a3d3c4016a69a6a0b9288190911137e5b8860b79`, `2026-07-29T07:07:14.359Z`, identifies the main-first/V2-only conflict;
  - structured prompt `fc_0d0c5bdb13a3d3c4016a69a6a257948190b51618dda4813aa0`, call `call_Ng5f0fLPyIrxjfHwz7biWabP`, `2026-07-29T07:07:18.221Z`, presents “Own them on v2” versus “Keep main-first”;
  - function output `fco_019facb5-464c-7ec0-9230-1d147fa2b9ef`, `2026-07-29T07:09:49.004Z`, selects “Own them on v2 (Recommended)”.

The branch-authority trajectory has no separate cited human event for publishing-from-V2, cutover, V1 retirement, or branch consolidation. The ADR explicitly records those as deliberate deferrals.

Explicit source gaps:

- The L1/L2 trajectory’s session metadata does not bind the session account to Tapan Chugh; structured answers have no stored actor role. Naming him is an accountability statement requiring his review of the linkage.
- No original simulator-decision session was located for `20260727-code-first-simulator-kernel.md`.
- For the simulator-system-driver outcome, the exact retained APIs, `StackProvider` ownership, RunLedger separation, immutable-SHA mechanics, testbed boundary, and legacy exclusions were assistant-authored without a later direct human event accepting each item. A machine-local worktree path was intentionally omitted.
- For the original main-first ADR, no stored user event separately states all branch and review mechanics.
- The freeze event’s “go” authorizes the preceding plan in context but is not item-by-item approval of every later trace row or conflict-resolution edit.

Per-question verdict: **PASS**

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest apparent contradiction is in the historical body and “Gate 0 review record” of `20260728-gate-1-architecture-freeze.md`, which says the freeze must be committed and merged on `main` before simulator work.

It is resolved, not a blocker:

1. The record is `partially-superseded`.
2. Its immediate “Supersession” section explicitly says `20260729-v2-authority-lives-with-v2.md` replaces the requirement that the freeze merge first on `main`.
3. The decision index says partially superseded historical bodies may retain vocabulary from their original design state; only explicitly retained scope remains current.
4. The higher/current V2-authority ADR places the complete V2 authority chain on the `v2` track.
5. The candidate manifest now follows that outcome while retaining a separate, compatible requirement that the simulator source baseline land on `main`.

Thus “V2 authority on `v2`” and “simulator source baseline landed on `main`” govern different artifacts and are compatible.

Historical drafts still containing main-first language are explicitly non-normative. I found no broken current lineage or unresolved authoritative contradiction.

Per-question verdict: **PASS**

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Yes. A teammate can implement this candidate’s authority/source-branch separation and execute the handoff gate without chat or guessing. They cannot begin the simulator port yet, because the repository deliberately records the gate as unsatisfied.

Deliberate pending gate state:

- landed source SHA unset;
- clean-tree, alignment-review, reviewer, and date fields unset;
- all entry-condition boxes unchecked;
- all verification results pending;
- mixed-runtime run IDs, digests, catalog version/tags, and teardown evidence pending;
- exact source-owning symbols and run representation await the landed source.

These are explicit blockers, not accidental omissions. The manifest says they must be filled before `verified`.

Relevant deliberate design deferrals:

- complete `HarnessClient` Effect signatures and portable errors;
- exact context-entry and search-result projections;
- clean-slate content-only event representation;
- payload-to-action mapping when several legal actions exist;
- checkpoint storage representation and buffer/resource policies;
- production `HarnessClient` adoption on `main`;
- publishing from V2, cutover, V1 retirement, and branch consolidation.

A port slice that needs one of these must wait for its named owner; it must not invent it.

Explicit historical provenance gaps:

- no located original human simulator-decision session;
- no human event individually accepting every detailed simulator gate/API choice;
- no account-to-Tapan binding in the V2-authority source session;
- no original main-first event spelling out every branch/review mechanism.

These are accidental source-record gaps, but they are explicitly disclosed rather than hidden. They do not create an implementation ambiguity because the admitted ADRs and current owners state the binding contract. They remain reasons for the named decision-maker to review the linkage.

Accidental current contract gaps: **None found.**

Per-question verdict: **PASS**

### Independently discovered paths and headings

- `v2/inputs/simulator-handoff-20260728.md` — Purpose; Source identity; Entry conditions; Preserve in the v2 port; Adapt for v2; Do not port; Status transition.
- `docs/decisions/README.md` — Canonical reading guidance.
- `docs/decisions/20260729-v2-authority-lives-with-v2.md` — Binding outcome; Guarantee; Deliberate deferrals.
- `docs/decisions/20260722-spec-lives-on-main.md` — Supersession.
- `docs/decisions/20260728-gate-1-architecture-freeze.md` — Supersession; Gate 1 traceability inventory; Gate 0 review record.
- `docs/decisions/20260728-simulator-is-the-system-driver.md` — Supersession; Decision Outcome.
- `docs/decisions/20260801-harness-client-owns-runtime-context.md` — Decision Outcome.
- `v2/AGENTS.md` — Authority and reading order; Simulator provenance gate.
- `v2/VISION.md` — Authority; Trust and failure envelope; Open-question register; The path.
- `docs/spec/layer-interfaces.md` — Simulator and testbed; StackProvider; Trust, safety, and progress; Dependency isolation.
- `docs/spec/harness/client.md` — Purpose and compatibility boundary; Explicitly deferred.
- `docs/architecture/first-implementation.md` — Gate 0; Gate 1; Gate 4; Explicit deferrals.
- `v2/inputs/README.md` — Source handoffs.
- The three non-quarantined trajectories governing original main-first authority, the Gate 1 simulator/freeze decisions, and the V2-authority reversal.

### Discovery trail

1. Recorded UTC start, candidate root, clean status, branch relation, and exact HEAD.
2. Listed repository structure and decision/evidence filenames without opening quarantined records.
3. Used commit name/status and the `origin/v2...HEAD` comparison to identify the sole candidate change.
4. Read the changed manifest and its linked decision/execution owners.
5. Followed the decision index through current, partially superseded, and fully superseded records.
6. Read the relevant current VISION, v2 agent law, layer interface, HarnessClient, implementation-plan, and input-index sections.
7. Read only targeted non-quarantined trajectory headings and events.
8. Searched current repository text while excluding all `docs/decision-evidence/**` contents and historical drafts where appropriate.
9. Resolved the strongest apparent main-first contradiction through frontmatter, Supersession, index guidance, and authority order.
10. Ran `git diff --check`, reconfirmed clean status, and recorded UTC end.

Blockers: **None**

Overall result: **PASS**
