# Blind decision review record

Candidate: the `Current execution entry` section added to
`docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md`,
which names the published `moltzap-sim` executable as a public boundary owned
by `@moltzap/simulator` while the Decision Outcome keeps its historical text.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260902-moltzap-sim-boundary-69bbfd9b` |
| Candidate commit | `69bbfd9be77ace14238f3aae08278e1f4ee8c409` |
| Candidate tree | `75daf77cd934aa1871722a1eae8237f9df5a0584` |
| Candidate content digest | `sha256:285cb8ac9c141e7d82c254c2e3fd966ebfd3fb2717e2ed7ea1ac95dbbeb4aa00` |
| Digest scope and command | the candidate record alone: `git show 69bbfd9b:docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md \| sha256sum` |
| Reviewer | Codex (`codex-cli 0.152.0`, `codex exec`, model reasoning effort `medium`) in a separate operating-system process |
| Reviewer session | `session id: 01a060c4-94a4-78b0-92fb-2603e4f7a8b5` |
| Review started | `2026-09-02T06:17:48Z` |
| Review finished | `2026-09-02T06:29:50Z` |
| Review duration | 12 minutes 2 seconds |
| Review budget | one uninterrupted pass, 15-minute hard timeout (`timeout 900`) |
| Rerun of | `none` |
| Rerun reason | `none` |

## Fresh-context attestation

Isolation was architectural, not by instruction: the reviewer was a separate
`codex exec` process started from a detached worktree at the candidate
commit (`git worktree add --detach /tmp/blind-69bbfd9b 69bbfd9b`), with
`--sandbox read-only`, `-C /tmp/blind-69bbfd9b`, and
`-c project_doc_max_bytes=0` so that no `AGENTS.md` or other project
instruction file was loaded. This deviates from the `cold-read` skill's
in-process `Agent` dispatch on purpose: an in-process subagent inherits the
parent session's memory and `AGENTS.md`, which PR-R's earlier runs showed
fails isolation. The reviewer's prompt carried only the six fixed questions
from `.claude/skills/cold-read/references/questions.md`, the quarantine rule
for earlier review records, the instruction not to read `.claude/` or
`agents/`, and the candidate's path.

The reviewer attests (recorded by the author from the process's inputs and
output; the reviewer's own statement is the `Author interventions: none`
line in its output):

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private
      state, or earlier blind-review output about the candidate.
- [x] I received only the clean candidate checkout and the fixed
      questions in this template.
- [x] I received no out-of-band tour, decision or file pointer, search
      term, expected answer, or answer key.
- [x] I navigated the repository independently. I may have used
      checked-in entry points, repository-native indexes, ordinary
      search, and repository history after discovering them myself.
- [x] I did not open, read, or search the contents of an earlier
      cold-review or invalid-review record. If an artifact path appeared
      in a listing or history, no answer or verdict from that
      quarantined record was returned. Engineering-review evidence
      recorded in candidate ADRs or trajectories is allowed.
- [x] I did not ask the author for help or modify the candidate before
      submitting these answers.
- [x] The author interventions recorded below are complete.

## Fixed questions and verbatim answers

The six questions are not restated here; they live in
`.claude/skills/cold-read/references/questions.md`. The reviewer's output is
reproduced verbatim below, unedited, including its own discovery trail,
blockers table, and result line.

---

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes the retained production Simulator execution contract current: one code-first `RunSpec`, one `Run.execute(spec)` library path, and one Kubernetes implementation selectable through local-Kubernetes or GKE Effect Layers. Each run is one temporary society; Kueue admits the whole roster, Agent Sandbox provides one application container per logical agent, runtime-specific bridges preserve exact native gateway types, an in-cluster controller waits for the complete cohort and invokes the customer Effect once, `RunLedger` records simulator evidence, and Temporal drives coarse lifecycle and cleanup (`docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md`, “Supersession,” lines 12–26; “Decision Outcome,” lines 69–233).

It resolves the gap between the earlier host/Docker implementation and experiments that need the same core simulator path on local Kubernetes and GKE. An example-only Docker path could not run the requested Kubernetes cohort, and the implementation needed to move container execution into `packages/simulator` without creating a second simulation model or exposing orchestration internals to experiment code (“Context and Problem Statement,” lines 53–67; “The public model is `RunSpec` and `Run.execute`,” lines 71–111).

Binding/current text is:

- The frontmatter status plus the visible “Supersession” section, because the decision index says only the explicitly retained portion of a partially superseded record remains current (`docs/decisions/README.md`, “Canonical reading guidance,” lines 32–58).
- “Current execution entry”: the public boundary is now `@moltzap/simulator`’s `moltzap-sim run --profile local|gke <spec.mjs>`, producing one `ProfileRunResult` stdout line (candidate, lines 28–39).
- The retained execution parts of “Decision Outcome”: `RunSpec`/`Run.execute`, exact runtime-specific gateways, the one-society lifecycle, failure/evidence semantics, local/GKE profiles, acceptance gates, non-goals, and owners (candidate, lines 69–299).
- The addressed Client cutover and public Simulator boundary owned by the replacement and `docs/spec/layer-interfaces.md`, including explicit addressed send/inbound delivery and removal of raw Router/order surfaces (candidate, lines 20–26; `docs/spec/layer-interfaces.md`, “Public boundaries retained through cutover,” lines 72–90, and “Simulator cutover,” lines 313–370).

Context and non-normative explanation are the “Context and Problem Statement,” “Consequences,” illustrative `RunSpec` snippet and explanatory examples, the provenance trajectories, and mechanical repository/GitHub events. The decision index expressly classifies context, consequences, and implementation examples as historical reasoning, while the trajectory labels itself non-normative (`docs/decisions/README.md`, lines 43–59; `docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md`, lines 1–9). The changelog records point corrections and current-state clarification; it says an outcome-changing edit requires supersession (candidate, lines 314–329).

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It replaces:

- The v1 `simulator.define(...).run(...)` naming and host-only execution path with `RunSpec` and `Run.execute`; the old entry point, in-process Effect runtime, and Docker example have been removed, with no Docker backend or compatibility facade (candidate, lines 100–111, 276–281).
- The Kubernetes realization of `effectRuntime({ build })` closures sharing in-process state. Code-peer policy now runs inside its Sandbox container and uses a runtime-specific bridge; no public scripted runtime or generic gateway protocol is introduced (candidate, lines 113–137, 283–289).
- Through the later addressed-messaging replacement, the old content-free open, raw Router runtime authority, and persisted Router commit/order evidence (candidate, lines 20–26; `docs/spec/layer-interfaces.md`, “Simulator cutover,” lines 313–370).

It retains:

- From `20260727-code-first-simulator-kernel.md`: the TypeScript/Effect model, immutable closed event catalog, typed simulation `RunLedger`, exact keyed roster, customer-owned scenario/sweep/completion/grading policy, and one simulator package (`docs/decisions/20260727-code-first-simulator-kernel.md`, “Supersession,” lines 12–42; candidate, lines 276–281).
- From `20260729-principal-io-uses-runtime-gateways.md`: exact runtime-native gateways, MoltZap social traffic, no universal gateway union/command/correlation model, distinct gateway versus network evidence, mixed societies, runtime termination as evidence, and behavioral-evaluation rules (`docs/decisions/20260729-principal-io-uses-runtime-gateways.md`, “Supersession,” lines 13–38; candidate, lines 283–289).
- From `20260729-effect-native-evaluation-results.md`: cases, grading, report resume, SQLite result authority, and Phoenix publication; only execution location changes (candidate, lines 291–294).
- The simulator execution baseline after addressed messaging: `RunSpec`, Kubernetes/Temporal execution, fault layers, simulation `RunLedger`, and non-conflicting public facades (`docs/spec/layer-interfaces.md`, lines 313–370).

It leaves `v2/*`, the v2 package/process map, generation model, and v2 trust contracts untouched (candidate, lines 41–46, 296–299).

The current normative contract is distributed but explicitly linked:

1. This candidate’s “Supersession,” “Current execution entry,” and retained execution outcome.
2. `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` and its further accepted replacements for current Client/adapter semantics.
3. `docs/spec/layer-interfaces.md`, especially “Exact package graph,” “Public boundaries retained through cutover,” and “Simulator cutover.”
4. The explicitly retained portions of the code-first, principal-gateway, and eval-result ADRs.

The source trajectories are evidence, not authority (`docs/decision-evidence/README.md`, opening and “Reading responsibility”).

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Keep `RunSpec { id, events, agents, cluster, execute }` code-first and immutable, with `Run.execute(spec)` as the library execution entry; profile selection changes only the `cluster` Layer (candidate, lines 71–104).
- Publish and preserve `moltzap-sim run --profile local|gke <spec.mjs>` as the package executable, route it through the same `Run.execute` path, and emit one schema-decodable `ProfileRunResult` line on success (candidate, lines 28–39; `docs/spec/layer-interfaces.md`, lines 81–85).
- Implement every Kubernetes roster entry as one logical agent in one Agent Sandbox application container, preserve its exact native gateway, attach its runtime-specific bridge only after readiness, and admit the exact roster at one cohort gate before dispatch (candidate, lines 113–128, 139–167).
- Use one coarse Temporal workflow, aggregate Kueue admission, a stable controller image with late experiment loading, simulator-ledger evidence, and run-owned cleanup (candidate, lines 139–173).
- Keep evaluation policy in `packages/evals`, execute all 32 OpenClaw/NanoClaw cells through Kubernetes, and satisfy the unit, local-smoke, larger-cohort, GKE-smoke, and GKE-evaluation gates (candidate, lines 214–233, 268–274).
- Apply the current addressed Client boundary: runtimes receive loopback MCP or injected `HarnessEndpoint`, never raw Router/Registry credentials, keys, stores, or fault controls (`docs/spec/layer-interfaces.md`, lines 313–370).

An implementer must avoid:

- A Docker execution backend, host compatibility facade, warm society, generic gateway proxy/protocol, serialized arbitrary JavaScript or Effect closures, customer-visible generation/recovery API, automatic replay, exactly-once external-effect claim, public Kubernetes/Kueue/Sandbox/Temporal model, per-agent Temporal workflow, or implementation under `v2/*` (candidate, lines 106–137, 235–266).
- Treating Temporal history or Kubernetes status as simulator evidence authority, or restoring product Ledger/Router-order evidence in `RunLedger` (candidate, lines 175–193; `docs/spec/layer-interfaces.md`, lines 335–360).
- Letting application runtimes impersonate agents, bypass the production Client/Router social path, or obtain network, signing, endpoint-store, or fault-control authority (candidate, lines 162–167; `docs/spec/layer-interfaces.md`, lines 331–366).

Affected owners and consumers are `@moltzap/simulator`/`packages/simulator` directly; `@moltzap/evals` as its consumer; root-owned image/build orchestration; and, at the runtime boundary, the public Identity, Router, and Client capabilities composed by Simulator. Production packages do not depend on Simulator or evals (`docs/spec/layer-interfaces.md`, “Exact package graph,” lines 16–41).

Fault, trust, safety, liveness, and compatibility assumptions are explicit:

- Before dispatch, Pod restart keeps a slot outside the gate; unrecoverable or never-ready acquisition fails and cleans up. After dispatch, termination is typed evidence interpreted by customer policy (candidate, lines 175–183).
- The controller invokes `execute` once and never replays it. Controller loss or infrastructure failure fails the run and starts cleanup; external side-effect idempotency belongs to customer code (candidate, lines 185–193).
- With no active directed link fault, exact Router bytes and recipient order are preserved. An explicitly active Simulator fault may drop, delay, hold, or reorder post-Router delivery, but cannot alter bytes, forge messages, or change Router state/order; such observations are endpoint-fault evidence, not Router-conformance evidence (`docs/decisions/20260813-simulator-link-faults-perturb-delivery.md`, “Guarantees” and “Isolation,” lines 25–62).
- Link faults may deliberately stop progress; no layer lowers a threshold or guesses missing ancestry (`docs/decisions/20260813-simulator-link-faults-perturb-delivery.md`, lines 64–75; `docs/spec/layer-interfaces.md`, “Cross-layer laws”).
- Production Temporal hosting/HA, Router HA, persistent-agent recovery, exhaustive NetworkPolicy, and a general multi-tenant security platform are not assumed (candidate, lines 203–212, 235–266).
- Compatibility is intentionally breaking where named: no old host/Docker facade, no generic gateway surface, and no removed OpenFloor/raw-Router/order contracts. Exact compatible declarations and the four retained Simulator facades remain (`docs/spec/layer-interfaces.md`, lines 72–90, 386–416).

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The ADR names one human decision-maker: **Tapan Chugh** (candidate frontmatter, line 4). The event ledger records actor roles such as `user` and `assistant`; it does not independently prove which human controlled those events (`docs/decision-evidence/README.md`, “Event-ledger rules”).

The compacted trajectory cites:

- Codex session `019fbbdd-7cff-7753-8541-4f66f0248d43`: user messages selecting main/core rather than an example, planning final shape first, accepting the preceding `RunSpec`/`Run.execute` proposal with “okay do this,” pulling GKE sandbox work and Kubernetes/Kueue/Temporal into the core, targeting `packages/simulator` rather than v2, replying “start” after the issue-plan summary, and directing work on issue #936 with end-to-end eval execution (`docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md`, items 1–7, lines 17–175).
- Earlier session `019fab08-15ca-7a10-a9af-f2a8441a45f5`: selected “Single-run cluster,” “2A Strict gate,” one container per agent, deferred offered 10k gates in favor of getting to ten agents first, selected Temporal + Kueue, deferred production Temporal hosting, selected Standard regional GKE, an in-cluster controller, CLI + library, Terraform + Helm, and Agent Sandbox gold (trajectory items 8–10, lines 177–304).
- A later live exchange, unavailable in workspace-readable session logs, that rejected an overcomplicated candidate, made prior checked-in requirements the boundary, and accepted a simplified proposal with “accept this ADR,” including controller-failure cleanup and no replay (trajectory “Source gaps, stated plainly,” lines 378–422).
- A later live exchange, also unavailable in workspace-readable logs, that replaced fixed cohort-size wording with an end-to-end experiment sized by its run and accepted point corrections; the literal excerpt is retained (trajectory “Later corrections,” lines 444–471).

The ledger explicitly records these gaps:

- Retained Codex events have no parent locator; some direct user events have no separate message ID.
- Terse acceptances are meaningful only with their directly preceding assistant prompts and do not independently supply rationale for every mechanism.
- No retained user event selected the `infrastructure`/`cluster` field spelling; the later `cluster` correction remains a ledger gap.
- No source selected bridge transport or wire schema; those remain private runtime-specific choices.
- The original `start` event did not by itself support the corrected no-replay/external-effects wording; the later explicit acceptance does.
- No retained event separately supplies reasons for every resource shape, failure variant, security control, event field, or platform mechanism.
- Exact versions, API schemas, chart/provider choices, timeouts, storage, cost budgets, generation protocols, artifact authorities, identity derivations, and recovery schemes are not human decisions in the excerpts.
- The live rejection/simplification and final acceptance exchanges lack native IDs, turns, timestamps, parent locators, and stored actor-role records because the checked logs did not contain them.
- Issue bodies/comments are agent-published mechanical artifacts, not independent human-authored rationale.
- The repository records no location for the asserted hundred-agent run’s exported ledger.
- No source event was located for the specific removal of `100-` from the scale-claim non-goal (trajectory lines 464–471).

The ledger records selected options and the stated deferrals above. Apart from noting that the 10k prompt offered tiered, live-model, and infrastructure-only gates and that none was selected, it does not provide a complete rejected-alternatives catalog.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest contradiction is GKE topology:

- The binding candidate says the reference is **regional GKE Standard** (`docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md`, “Local and GKE are two profiles of one path,” lines 203–208).
- Its source ledger records selection of “Standard regional” (trajectory item 9, lines 250–257).
- `packages/simulator/gke/profile.json` also says `"topology": "regional"` (lines 3–8).
- But the current operator README says “zonal GKE Standard” and explains zonal cost/topology (`packages/simulator/gke/README.md`, lines 1–7, 44–46, 59–65).
- Terraform provisions `google_container_cluster.simulator.location = var.zone`, and the profile test explicitly pins a zonal cluster (`packages/simulator/gke/terraform/main.tf`, lines 110–114; `packages/simulator/gke/profile.test.mjs`, lines 99–116).

The authority order resolves this in favor of **regional**: the decision index says frontmatter and current accepted/explicitly retained outcomes govern conflicts, while implementation prose and tests are not normative (`docs/decisions/README.md`, lines 32–59). Therefore the zonal README, Terraform, and test are stale implementation artifacts and must be changed to the regional contract; they do not authorize changing the ADR or `profile.json` to zonal.

This is a real conformance defect, but not an unresolved decision or lineage blocker: the required topology is discoverable without guessing.

A lesser apparent CLI contradiction is already resolved inside the candidate: the historical Decision Outcome retains “repository-local CLI,” while “Current execution entry” names the now-public `moltzap-sim` package boundary and points to the normative spec (candidate, lines 28–39, 195–201, 314–329).

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Yes. The public API, ownership, lifecycle, fault behavior, acceptance evidence, removed surfaces, and authority chain are sufficiently explicit. A teammate must follow the regional GKE contract and correct the stale zonal implementation identified above.

| Item | Classification | Effect on implementation |
|---|---|---|
| Production Temporal hosting and HA | Deliberate deferral | Qualification may use the development deployment or a configured endpoint; no production-HA design is required. |
| Runtime-specific bridge transport and wire schema | Deliberate private implementation choice | Each runtime may choose one fixed internal transport; it must not become a universal gateway protocol. |
| Experiment bundle transport and cache | Deliberate private profile choice | Implement behind the profile boundary; do not create a public artifact protocol. |
| Generation IDs, restart/rebind/rejoin, in-flight recovery, replay/resume, exactly-once external effects | Deliberate non-goal | Do not implement; fail and clean up under the stated semantics. |
| Durable artifact authority, start-or-attach database, global execution IDs, UUID/name-hashing contract | Deliberate non-goal | Private mechanics may exist only as needed; no public/normative authority is introduced. |
| New serialization grammar or universal result/failure schema | Deliberate non-goal | Reuse existing schemas plus fixed private bridge/checksum formats. |
| Public orchestration APIs, arbitrary Pod templates, per-agent Temporal workflows | Deliberate non-goal | Keep Kubernetes/Kueue/Sandbox/Temporal private behind the Effect Layer. |
| Warm pools, fairness, borrowing, preemption, multi-run scheduling, Router HA, Simulator-owned cohort autoscaling | Deliberate non-goal | One run owns one temporary society; cluster node-pool autoscaling remains allowed. |
| Exact Secret-provider protocol, persistent agent-state recovery, exhaustive NetworkPolicy, multi-tenant security platform | Deliberate non-goal | No such platform is needed for this slice. |
| Nomad, Slurm, managed batch, GKE Autopilot, or another backend | Deliberate non-goal | Retain one Kubernetes path only. |
| Fixed scale-qualification number | Deliberate deferral/correction | Use one larger-cohort experiment sized by its run; make no 100/1,000/5,000/10,000 claim before gates pass. |
| Final publication/version policy and external-consumer cutover | Deliberate deferral | It cannot add a package, compatibility facade, or restore removed Simulator contracts (`docs/spec/layer-interfaces.md`, lines 418–424). |
| Exact upstream versions, chart/provider selections, timeouts, storage mechanisms, and cost budgets as human decisions | Deliberate implementation detail per the source-gap ledger | These are not part of the human normative decision; checked-in profile assets may pin operational choices. |
| Human source for `cluster` rather than `infrastructure` | Accidental provenance gap, explicitly recorded and non-blocking | The current ADR, source type, and orientation docs all consistently require `cluster`; no implementation guess remains. |
| Exported evidence location for the stated hundred-agent run | Accidental evidence gap, explicitly recorded | The historical claim cannot be repository-verified, but current acceptance does not require that artifact or a fixed hundred-agent gate. |
| Source event for removing `100-` from the scale-claim non-goal | Accidental provenance gap, explicitly recorded | The current non-goal still forbids a 100-agent claim before the named gates; implementation behavior is clear. |
| Regional ADR/profile versus zonal Terraform/README/test | Accidental implementation drift, authority-resolved | Implement regional GKE Standard and update the stale zonal artifacts. |

## Discovery trail

| Order | Entry point or search | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Direct candidate read | `docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md` — full record | Found status, retained execution contract, current CLI boundary, supersession, outcome, non-goals, owners, and changelog. |
| 2 | Repository file inventory | `docs/decisions`, `docs/decision-evidence`, `docs/spec`, `packages/simulator`, `packages/evals`, `scripts` | Located normative indexes, trajectories, replacement ADRs, implementation docs, and checks; quarantined review contents were not opened or searched. |
| 3 | Provenance follow | `docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md` — “The main simulator runs container societies on Kubernetes,” “Source gaps,” “Later corrections” | Found event locators, literal calls/selections, explicit deferrals, later corrections, and source gaps. |
| 4 | Authority follow | `docs/decisions/README.md` — “Canonical reading guidance”; `docs/decision-evidence/README.md` — “Event-ledger rules,” “Reading responsibility” | Established status/supersession authority and that trajectories are evidence, not normative authority. |
| 5 | Supersession follow | `docs/decisions/20260827-addressed-messaging-replaces-openfloor.md` — “Supersession,” “Decision Outcome” | Found current addressed Client replacement and its further narrowed replacements. |
| 6 | Normative-owner follow | `docs/spec/layer-interfaces.md` — “Exact package graph,” “Public boundaries retained through cutover,” “Simulator cutover,” “Acceptance criteria,” “Deliberate deferrals” | Found the final seven-package ownership, public `moltzap-sim` boundary, runtime/Client cutover, fault isolation, and explicit remaining deferrals. |
| 7 | Earlier-outcome follow | `docs/decisions/20260727-code-first-simulator-kernel.md` — “Supersession”; `20260729-principal-io-uses-runtime-gateways.md` — “Supersession”; `20260729-effect-native-evaluation-results.md` — “Decision Outcome” | Distinguished retained code-first, gateway, ledger, evaluation, and publication contracts from replaced host realizations. |
| 8 | Later fault-contract search | `docs/decisions/20260813-simulator-link-faults-perturb-delivery.md` — “Guarantees,” “Isolation,” “Consequences” | Found current post-Router fault ordering, safety, authority, and progress assumptions. |
| 9 | Public-boundary implementation check | `packages/simulator/package.json`; `packages/simulator/README.md`; `scripts/architecture/check-boundaries.js` | Confirmed the package bin, public executable, result schema documentation, and static boundary pin. |
| 10 | GKE consistency search | `packages/simulator/gke/profile.json`; `gke/README.md`; `gke/terraform/main.tf`; `gke/profile.test.mjs` | Found the regional-versus-zonal contradiction and resolved it through ADR authority. |
| 11 | Targeted Git history | Candidate, spec, package manifest, and executable history | Confirmed the current execution-entry clarification and that the historical CLI sentence was intentionally retained while current ownership moved to the public-boundary section. |

Author interventions: none

## Blockers

| Blocker | Evidence/location | Impact |
|---|---|---|
| None | The strongest repository contradiction—regional normative GKE versus zonal implementation—is resolved by the documented authority order. | No chat or new decision is required; implementation must conform the stale GKE assets to the regional contract. |

Result: PASS — the retained execution decision, current normative owners, provenance, and explicit deferrals are discoverable; authority resolves the regional-versus-zonal drift, and no material unresolved implementation choice requires chat or guessing.

---

## Discovery trail

Recorded verbatim by the reviewer in the output above (its `Discovery trail`
table, eleven steps from the candidate record through the decision index,
the provenance trajectory, the replacement record, `docs/spec/layer-interfaces.md`,
the earlier retained records, the fault-contract record, the package
manifest and boundary check, the GKE assets, and targeted Git history).

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| `none` | `none` | `none` |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| `none` | The reviewer's strongest contradiction, regional GKE Standard in the candidate and `gke/profile.json` versus zonal wording in `gke/README.md`, `gke/terraform/main.tf`, and `gke/profile.test.mjs`, predates the candidate and was resolved by the reviewer through the authority order in favour of the record. | Question 5 answer above. | None for this candidate; the stale zonal implementation artifacts are a separate conformance follow-up, not a change to the record. |

## Overall result

Result: **PASS**

Rationale (the reviewer's): the retained execution decision, current
normative owners, provenance, and explicit deferrals are discoverable;
authority resolves the regional-versus-zonal drift, and no material
unresolved implementation choice requires chat or guessing.

## Maintainer acceptance

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `20260902-moltzap-sim-boundary-69bbfd9b` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `none` |
| Superseded candidate commit | `none` |
| Superseded candidate content digest | `none` |
| Reason a rerun was required | `none` |
