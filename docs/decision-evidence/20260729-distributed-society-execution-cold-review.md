# Blind decision review record — distributed society execution

## Review identity

| Field | Value |
|---|---|
| Review run ID | `dse-cold-20260729-02` |
| Candidate commit | `772e05efd824324e8d13e567bb384548725da966` |
| Candidate tree | `9963222e9ae2679cbf5879e2356fd2dc055b7679` |
| Candidate content digest | SHA-256 `1a301aa99a99de696a6892ee09d8b795f23cff6dd5bfeacc654ecc26eb72213a` |
| Digest scope and command | Git archive of the candidate commit: `git archive --format=tar 772e05efd824324e8d13e567bb384548725da966 \| shasum -a 256` |
| Reviewer | Codex fresh reviewer |
| Reviewer session | `/root/blind_adr_review_fresh` |
| Review started | `2026-07-29T22:01:58Z` |
| Review finished | `2026-07-29T22:07:38Z` |
| Review duration | 5 minutes 40 seconds |
| Review budget | One uninterrupted fresh-agent turn, maximum 45 minutes; fixed at `2026-07-29T22:01:23Z` |
| Rerun of | `dse-cold-20260729-01-invalid` |
| Rerun reason | The first reviewer could not make the literal isolation attestation because unavoidable platform governance and environment metadata were present. Its substantive findings were not returned or used. |

## Reviewer report — verbatim

# Fresh-context blind review report

## Candidate and reviewer

- Repository: `/Users/tapanc/moltzap/.claude/worktrees/v2-society-execution`
- Candidate: `772e05efd824324e8d13e567bb384548725da966`
- Candidate parent: `26e81c8175dff900151c755ab9f63c778377ff77`
- Frozen semantic commit: `26e81c8175dff900151c755ab9f63c778377ff77`
- Semantic base: `0508955433b59f98ca3315b5631eb23ffa907cb1`
- Semantic tree: `ede6a829a9f564a8f5bd86405a3ce082225d0383`
- Candidate tree: `9963222e9ae2679cbf5879e2356fd2dc055b7679`
- Reviewer: Codex fresh reviewer session `/root/blind_adr_review_fresh`
- Budget fixed: `2026-07-29T22:01:23Z`, maximum 45 minutes
- Review start: `2026-07-29T22:01:58Z`
- Review finish: `2026-07-29T22:07:38Z`
- Duration: 5 minutes 40 seconds
- Repository state at start and finish: clean, exact candidate checked out
- Mutations: none

## Fresh-context attestation

- [x] I did not author or reconcile this candidate.
- [x] I received no inherited decision-making conversation, compaction, candidate summary, candidate-specific design-file pointer, search term, expected answer, earlier review output, or author coaching.
- [x] I received only the repository root, candidate commit, review constraints, and the six fixed questions as candidate-specific briefing.
- [x] Unavoidable platform governance and environment metadata were present. I did not treat those paths or statements as candidate evidence or discovery hints; I independently listed the candidate repository and read its exact checked-in governance files.
- [x] I used one uninterrupted fresh-agent turn and remained within the fixed 45-minute budget.
- [x] I did not ask the author for help or clarification.
- [x] I excluded `**/*-cold-review.md` and `**/*invalid-review*` from broad listings and searches and did not open, read, or search any such artifact.
- [x] A current, non-quarantined Gate 1 ADR mentions that an older review existed. I did not use that reported status or follow it into a quarantined artifact.
- [x] All inspection was read-only.

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

**Verdict: PASS**

The candidate makes five linked accepted post-Gate-1 decisions current:

1. A distributed cohort maps one expected `AgentId` to one container, and customer Effect code may be dispatched only after an exact full-roster readiness barrier. One run-scoped independent Registry, Router, and Ledger core plus one daemon/runtime bridge per `AgentId` serves one program dispatch, then tears down. No restart, replacement, rebinding, warm reuse, second dispatch, packed agent, init container, or sidecar belongs to this profile.

2. General Kubernetes is the first backend, regional GKE Standard is authoritative, and Kueue admits the complete homogeneous plain-Pod cohort as one aggregate resource workload. Admission is not semantic readiness. Agent Pods are non-restarting, non-replacing, on-demand workloads with one container each.

3. Temporal owns one coarse Workflow per society submission. Kubernetes/Kueue own placement and capacity; an in-cluster controller and testbed Layers own one execution of the customer Effect program. Temporal does not model agents individually, replay customer code, decide roster readiness, or synthesize RunLedger evidence. BullMQ and Redis are absent.

4. A stock digest-pinned OpenClaw image is the compatibility baseline. MoltZap runtime material and experiment inputs are verified, content-addressed late-bound artifacts. A preinstalled optimized image is optional and cannot become the correctness path. OpenClaw `startAccount` remains the daemon supervisor.

5. A short-lived Pod-bound Kubernetes token attests workload membership to the testbed controller. It is not an `AgentId`, L1 credential, Registry admission credential, or product-traffic authentication mechanism. TokenReview, live-Pod validation, controller-derived slot identity, and atomic Pod-UID binding gate release of only that slot’s bootstrap and key/profile material.

The candidate also corrects the lineage of `20260727-code-first-simulator-kernel.md`: it is now `partially-superseded`. Its code-first definition, closed EventCatalog, RunLedger, scoped roster, lifecycle, runtime-exit evidence, and customer Effect policy remain current. Its v1 package/process/mechanism ownership is historical and replaced by the accepted v2 simulator/testbed split.

The resolved problem is how to run a single code-first society at 1,000–10,000-container scale without:

- dispatching into a partial or already degraded roster;
- allowing packed agents to share the modeled failure/credential boundary;
- confusing capacity admission with semantic readiness;
- allowing scheduler replacement to silently change simulator semantics;
- rebuilding images for every experiment edit;
- conflating Kubernetes workload identity with MoltZap L1 identity;
- replaying arbitrary Effect code after controller failure; or
- violating the existing six-package, independent-process, and Router-content-blind boundaries.

Binding authority is:

- candidate `AGENTS.md` and `v2/VISION.md`;
- the five accepted ADR `Decision Outcome` sections;
- the explicitly retained `Supersession` scope of the partially-superseded simulator ADR;
- `docs/spec/distributed-society-execution.md`;
- the existing Gate 1 contract, especially `docs/spec/layer-interfaces.md`;
- the normative negative scope in `Deliberate deferrals`.

Non-normative or contextual material is:

- ADR context, consequences, and external references;
- `docs/architecture/distributed-society-execution.md` and other architecture orientation;
- the source-event trajectory and source-gap report;
- E19’s agent-authored plan;
- historical bodies explicitly marked replaced;
- implementation examples and unselected first-scope questions.

The accepted post-Gate-1 chapter binds a later target but does not authorize implementation before Gate 1 prerequisites and a separate implementation-scope decision.

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

**Verdict: PASS**

Formal ADR lineage:

- The candidate changes `20260727-code-first-simulator-kernel.md` from `accepted` to `partially-superseded`.
- It retains the code-first simulator definition, closed typed event catalog, RunLedger/evidence, roster, private scoped kernel, runtime-exit evidence, and customer Effect policy.
- It replaces the historical v1 claim that one simulator package owns platform mechanisms and retires `testbed`. The replacement is `20260728-simulator-is-the-system-driver.md`, with the current package contract in `docs/spec/layer-interfaces.md`.
- The decision index shows the same status and replacement.

Session-level evolution, distinct from formal ADR supersession:

- E02’s queue/operator-free detail is superseded by E11’s Temporal-plus-Kueue selection; the one-run lifecycle remains.
- E03’s proposed Router-visible readiness mechanism is not retained. The strict barrier guarantee moves to controller/testbed/private-kernel state because Router has no presence or readiness semantics.
- E06 first selects both runtimes, then the later direct user message narrows the distributed first path to OpenClaw. NanoClaw remains part of Gate 1 mixed-runtime acceptance but distributed NanoClaw is deferred.
- E08’s per-experiment image direction and narrow-GHCR alternative are rejected by the later user message. The current contract uses stable images plus content-addressed late-bound experiment artifacts.
- E15’s in-cluster location is retained, but the agent proposal’s controller ownership of Router is not. The controller acquires independent Registry, Router, Ledger, daemon, and cohort resources through testbed Layers.
- E19’s proposed Router registration/presence operations, umbrella MoltZap server, and seventh `@moltzap/simulator-runner` package are not retained because they conflict with higher v2 law.

The target explicitly leaves untouched:

- every Gate 1 wire, identity, Router, Transcript, endpoint-daemon MCP, package/export, and completion requirement;
- the six-package graph and five production executables;
- independent Registry, Router, Ledger, and per-`AgentId` daemon processes;
- the rule that Router owns neither registration nor runtime presence/readiness;
- Gate 1’s product fault model;
- NanoClaw’s Gate 1 mixed-runtime acceptance obligation;
- the distinction between product Transcript and simulator RunLedger.

The current normative contract lives in:

- `AGENTS.md` and `v2/VISION.md`;
- the five `20260729-*` accepted ADRs;
- `docs/decisions/20260728-simulator-is-the-system-driver.md`;
- the retained `Supersession` scope of `docs/decisions/20260727-code-first-simulator-kernel.md`;
- `docs/spec/distributed-society-execution.md`;
- `docs/spec/layer-interfaces.md`;
- the accepted-post-Gate-1 index in `docs/spec/README.md`.

Architecture pages orient but do not own the interface.

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

**Verdict: PASS**

An eventual implementation must:

- Keep the portable definition, expected-roster contract, private kernel, EventCatalog, and RunLedger in `simulator`; place Kubernetes, Kueue, Temporal, enrollment, bootstrap, supervision, and cleanup mechanisms in `testbed`.
- Acquire the independent run-scoped Registry, Router, and Ledger core first, then register or validate declared profiles and freeze the immutable `AgentId` roster before creating agent Pods.
- Create one homogeneous externally managed plain Pod per roster slot, with `restartPolicy: Never`, one container, no init container, no sidecar, no replacing owner, and no accepted second UID.
- Use Kueue for complete-group aggregate quota without partial admission, preemption, replacement, requeue, or Spot capacity in the reference profile.
- Use regional VPC-native GKE Standard with Dataplane V2, a stable system pool, and a dedicated homogeneous on-demand agent pool.
- Bind authenticated operational readiness to the enrolled Pod UID and roster slot; require profile/card resolution, `EndpointProfileRef`, matching daemon discovery, OpenClaw daemon supervision, and the sole loopback MCP subscription.
- Latch observed service loss, exit, deletion, replacement, enrollment failure, duplicate identity, and readiness invalidation.
- Durably append exact-roster-ready evidence, recheck all handles, then append dispatch-attempt evidence immediately before invoking customer code once.
- Treat a detected pre-dispatch failure as whole-cohort acquisition failure and a post-dispatch autonomous exit or infrastructure loss as typed customer-policy evidence.
- Use one coarse Temporal Workflow per submission and idempotent aggregate reconciliation only.
- Preserve controller-loss semantics: fail the run, do not replay arbitrary Effect code, do not replace agents, and do not let Temporal or the reconciler fabricate simulator completion.
- Use the stock digest-pinned OpenClaw path with a verified version-matched adapter/daemon bundle. Bootstrap installs but does not start the daemon; `startAccount` supervises it.
- Keep experiment code, instructions, workspaces, and dependency manifests content-addressed and separate from stable image identities.
- Perform TokenReview and live-Pod checks before atomically binding a Pod UID to a controller-derived slot and releasing only that slot’s material.
- Use finite Pod deadlines and an expired-run reconciler to bound orphaned capacity when the relevant cluster services remain available.
- Prove a two-agent smoke if useful, then a conforming 10-container gate before staged 100, 1,000, 5,000, and 10,000-container evidence.

An implementer must avoid:

- Router registration, presence, roster, or runtime-readiness operations;
- an umbrella production server or controller-owned Router semantics;
- a seventh package, unapproved export, or new binary;
- leaking scheduler/cloud/orchestration mechanisms into `simulator`;
- packed or synthetic agents in a distributed-conformance count;
- agent Pod restart, replacement, rebinding, init containers, or sidecars;
- partial Kueue admission, preemption, Spot reference results, or replacement owners;
- per-agent Temporal entities, BullMQ, Redis, customer-program replay, or Temporal-written RunLedger evidence;
- using Kubernetes tokens as product identity or granting agent ServiceAccounts Kubernetes RBAC or GCP IAM;
- shared roster impersonation credentials;
- requiring a preinstalled MoltZap/OpenClaw image for correctness;
- giving the OpenClaw bridge direct Registry, Router, Ledger, database, or protocol-engine authority;
- claiming direct Pod-to-Pod network isolation, VM-strength isolation, a perfect failure detector, fixed startup time, fairness, or protocol liveness at 10,000 agents;
- deciding any listed implementation deferral accidentally.

Affected ownership and consumers:

- `testbed`, the simulator’s private kernel and `StackProvider`, RunLedger evidence, controller/orchestration composition, Kubernetes/Kueue/GKE/Terraform/Helm, OpenClaw runtime bootstrap, endpoint-daemon supervision, and Registry bootstrap/enrollment.
- The CLI-shaped and TypeScript submission consumers are required eventually, but their package/export/binary owner is deferred.
- OpenClaw is required for the first distributed slice. Other runtimes remain permitted; NanoClaw distributed conformance is deferred.
- Product L1–L4 semantics remain unchanged. Router/L2 is explicitly unaffected by readiness and orchestration.

Trust and fault assumptions:

- Gate 1 continues to assume one correct non-equivocating Registry, one correct non-equivocating Router, and one correct durable Ledger; endpoints may be Byzantine.
- Distributed acquisition additionally trusts the Kubernetes control plane and TokenReview result, the testbed controller’s workload-to-slot binding and secret release, and node-kernel/container-runtime isolation.
- The submitting operator and arbitrary TypeScript/Effect bundle are trusted.
- Agent containers may still become faulty or malicious after receiving their own slot material.
- The profile does not tolerate container escape, kernel compromise, a malicious submitted experiment bundle, or an equivocating Registry.
- Availability of cluster capacity, Registry, object storage, production services, successful bootstrap, and a live controller conditions progress.
- Temporal and the reconciler can bound cleanup only while their required services and Kubernetes remain available.
- Readiness is a controller-observed safety barrier, not a perfect simultaneous physical snapshot. A crash whose notification has not reached the controller is outside that observation.
- The 1,000–10,000 number is an acceptance target, not a protocol liveness guarantee.

Compatibility assumptions:

- V2 has no internal v1 compatibility obligation and may not import `packages/*`.
- The exact six-package/export/binary contract remains fixed.
- Gate 1 wire and protocol compatibility are unchanged.
- The stock OpenClaw image is the compatibility baseline; private mirroring and optimized images may not change semantics.
- Generic Kubernetes may preserve the same contract. Nomad and other schedulers are not first implementations.

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

**Verdict: PASS**

All five new ADRs and the corrected simulator ADR name **Tapan Chugh** as decision-maker.

The trajectory explicitly states that a stored `user` role identifies the source account role but does not independently authenticate Tapan Chugh. It also distinguishes user selections, agent prompts/proposals, tool results carrying selections, and mechanical repository reconciliation.

Event linkage:

- One-container/readiness ADR: E01, E02, E03, E04, E05, E07, E09, E19, and E20.
- Kubernetes/Kueue ADR: E01, E09, E10, E11, E13, E14, E18, E19, and E20.
- Temporal/controller ADR: E02, E10, E11, E12, E15, E16, E17, E19, and E20.
- OpenClaw late-binding ADR: E08, E10, the later narrowing in E06, E19, and E20.
- Pod-attestation ADR: E09, agent-authored E19, and user instruction E20.
- Simulator lineage correction: no original source event was located; E20 instructs the session to update to v2 and follow the ADR process but does not supply the original outcome or independently select the mechanical lineage correction.

Calls, alternatives, reversals, and deferrals recorded by the ledger:

- E01 requests 1,000–10,000 agents, containerization, waiting for all agents, and then dispatch.
- E02 selects a single-run cluster. Its queue/operator-free detail is later superseded, while the one-run scope remains.
- E03 selects a strict cohort gate. Its Router-visible proposed mechanism is later rejected by v2 law, while the guarantee is retained.
- E04 selects one Pod per logical agent.
- E05 selects none of the three offered scale-proof options and records the user note to defer 4A/4B scale and reach 10 agents first.
- E06 selects both runtimes in milestone one, followed by a direct user message that NanoClaw may be skipped.
- E07 selects host choice at the Layer.
- E08 selects an in-cluster run Job, rejects the first two image-delivery options in favor of seeking a middle ground, selects narrow GHCR while asking whether OpenClaw images already exist, and is then followed by a direct user rejection of per-experiment OCI-image churn.
- E09 asks about alternatives such as Slurm, selects hostile OS isolation, and directly states one container per agent.
- E10 raises Temporal, GCP, GKE plus Temporal plus BullMQ, the stock OpenClaw image as the gold path, an optimized image only as an optional optimization, and private-registry use.
- E11 selects Temporal plus Kueue without Redis/BullMQ.
- E12 selects local Temporal first and deliberately defers production hosting.
- E13 selects GKE first with a future Nomad seam.
- E14 selects regional GKE Standard.
- E15 selects an in-cluster controller.
- E16 selects readiness-only proof at 1,000–10,000 scale.
- E17 selects CLI plus library as the eventual submission surface.
- E18 selects Terraform plus Helm.
- E19 is explicitly agent-authored. It proposes Kueue plain-Pod settings, Pod-bound TokenReview enrollment, controller mechanics, exact failure behavior, artifact handling, scale gates, Router presence, an umbrella server, and a seventh runner package. The trajectory separately identifies which parts are reconciled or rejected under v2 law.
- E20 is a stored-user instruction to create a new worktree, update the plan to v2, realize the decisions and plans as ADRs, and discuss first implementation scope later.

Explicit source gaps and omissions:

- No source event was located for the original `20260727-code-first-simulator-kernel.md` decision. The separate source-gap report records searches and refuses to reconstruct it from ADR prose or Git history.
- The source has no per-user-message ID or parent locator. None is invented.
- Hidden reasoning, system prompts, research payloads, credentials, and irrelevant inspection are omitted.
- Exact Kueue plain-Pod settings, Pod attestation, GKE topology, and controller-failure mechanics originate in agent-authored E19. E20 directs the ADR process but supplies no separate human rationale for each mechanism.
- The v1-to-v2 translation—independent services, readiness outside Router, six packages—is repository-law reconciliation, not evidence of human rationale.
- No direct user event independently chooses exact TypeScript APIs, event tags, resource sizes, timeout defaults, Terraform module layout, production Temporal hosting, or the first implementation slice.
- No retained source event selects the operational-readiness transport/schema, exact package-manager command, bundle format, cache policy, GCS path, or direct Pod-to-Pod NetworkPolicy posture.
- The source does not assign CLI/library ownership compatibly with the exact export map.
- No source selects Slurm, managed batch, Autopilot, or initial Nomad. A GCP Batch question was aborted without an answer and is not interpreted.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Verdict: PASS**

The strongest apparent contradiction is the historical body of `docs/decisions/20260727-code-first-simulator-kernel.md`. It says one simulator package owns Node/Docker/OpenClaw/NanoClaw/platform mechanisms and retires the parallel `testbed` API. That directly conflicts with current v2 law, the six-package graph, and the new distributed target’s placement of platform orchestration in `testbed`.

The candidate resolves this without silently rewriting history:

- frontmatter is now `partially-superseded`;
- `superseded-by` names `20260728-simulator-is-the-system-driver.md`;
- the visible `Supersession` section precisely retains the code-first kernel/evidence contract;
- it marks the v1 package/process/mechanism claims historical;
- the decision index reports the same status and replacement;
- the replacement ADR and `docs/spec/layer-interfaces.md` own the current simulator/testbed boundary;
- `docs/spec/distributed-society-execution.md` owns only the post-Gate-1 distributed profile.

Because the contradictory text is explicitly outside retained current scope, this is resolved lineage rather than a current-authority conflict.

A second apparent conflict is Gate 1 architecture text saying deployment remains deferred while the new target selects Kubernetes, GKE, Kueue, and Temporal. The candidate resolves that through status and scope: the new chapter is an accepted **post-Gate-1 target**, does not alter Gate 1 completion, and still blocks concrete implementation until prerequisites and a separate implementation-scope decision. The Gate 1 deferral remains true for Gate 1 itself.

No unresolved contradiction or broken lineage was found.

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

**Verdict: PASS for discoverability and decision completeness; concrete coding remains intentionally gated.**

A teammate can reconstruct the accepted guarantees, boundaries, conformance criteria, failure behavior, and prohibited shortcuts without chat. They cannot yet choose the first concrete implementation slice without making unrecorded choices. The candidate explicitly forbids that and requires a separate implementation-scope decision.

All implementation choices left open by the normative chapter are classified as **deliberate deferrals**:

1. Exact TypeScript symbols, constructors, event tags, public methods, and RunLedger schemas.
2. `PrincipalId`/`AgentName` allocation, generated versus supplied key/profile sources, and roster-resolution API.
3. Operational-readiness transport, session/poll/lease choice, schema, freshness, authentication envelope, and binding to Pod attestation.
4. Package/export/binary ownership of CLI and TypeScript submission surfaces.
5. Terraform modules, Helm layout, region, machine types, requests, quotas, autoscaling, and timeout values.
6. Kubernetes/PostgreSQL resource shapes for Registry, Router, Ledger, and RunLedger storage.
7. Controller and Temporal-worker resource shape, placement, credentials, and aggregate-status transport.
8. Bundle format, package-manager commands, cache layout, GCS paths, and optimized-image release automation.
9. One versus several controller/platform-service images and their release automation.
10. Source and release ownership of the v2 OpenClaw adapter and MoltZap runtime bundle within the existing six-package/external-consumer law.
11. NetworkPolicy posture and exact labels, annotations, audience, token lifetime, RBAC resources, TLS, secret envelope, selectors, CIDRs, active deadlines, expiry, and scan literals.
12. Expired-run reconciler shape, owner, placement, RBAC, credentials, and deployment.
13. Production Temporal hosting, exact Activities, Signals, retries, and status schema.
14. Nomad, Slurm, managed batch, serverless, Autopilot, and NanoClaw distributed implementations.
15. Controller checkpoint/resume, transparent replacement, multi-cluster placement, and multi-Router sharding.
16. Warm societies and multiple dispatches from one acquired cohort.
17. Concurrent-run admission, fairness, namespace allocation, multi-tenancy, and cross-run isolation.
18. Hostile/untrusted submitted experiment code and multi-tenant controller isolation.
19. A mandatory 10,000-simultaneous-paid-model-call gate.
20. The coherent subset constituting the first implementation slice.

The architecture page further turns the first slice into an explicit next-decision checklist: submission surface, internal cohort contract and event schemas, roster allocation, service/storage shapes, controller/worker shapes, local Kubernetes/Kueue/Temporal composition, network posture, reconciler, runtime-bundle format, local Pod attestation, and two-/ten-agent gates.

No accidental implementation gap was found. The missing original source event for the 20260727 simulator ADR is a provenance gap, not an unclassified implementation choice; it is explicitly recorded and does not obscure the current retained/replaced contract.

## Independently discovered evidence paths and headings

- `AGENTS.md`
  - `Constitution`
  - `Architecture decision records`
  - `Decision provenance`
  - `Lifecycle and landing`
  - `Blind teammate review gate`
  - `Docs`
- `v2/VISION.md`
  - `Authority`
  - `The constitution`
  - `Gate 1 profile`
  - `Trust and failure envelope`
  - `Packages and versions`
  - `Open-question register`
- `docs/decisions/README.md`
  - `Canonical reading guidance`
  - `Records`
- Five new `docs/decisions/20260729-*.md` records
  - `Context and Problem Statement`
  - `Decision Outcome`
  - `Consequences`
- `docs/decisions/20260727-code-first-simulator-kernel.md`
  - `Supersession`
  - `Decision Outcome`
- `docs/decisions/20260728-simulator-is-the-system-driver.md`
  - `Decision Outcome`
- `docs/spec/README.md`
  - `Authority and reading order`
  - `Accepted post-Gate-1 chapters`
- `docs/spec/distributed-society-execution.md`
  - `Scope`
  - `Ownership`
  - `Distributed cohort contract`
  - `Kubernetes and GKE reference profile`
  - `Temporal and controller contract`
  - `OpenClaw artifact contract`
  - `Pod enrollment and identity separation`
  - `Trust, safety, and progress`
  - `Conformance and staged evidence`
  - `Deliberate deferrals`
- `docs/spec/layer-interfaces.md`
  - `Package graph`
  - `Simulator and testbed`
  - `StackProvider`
  - `Distributed society execution`
  - `Trust, safety, and progress`
- `docs/architecture/distributed-society-execution.md`
  - `Runtime topology`
  - `Run phases`
  - `Control and evidence boundaries`
  - `Scale proof`
  - `First-scope questions`
- `docs/architecture/first-implementation.md`
  - `Completion criteria`
  - `Explicit deferrals`
  - `Accepted post-Gate-1 distributed target`
- `docs/decision-evidence/20260729-distributed-society-execution-trajectory.md`
  - E01–E20
  - `Decision linkage`
  - `Candidate repository effects frozen`
  - `Source gaps and omissions`
- `docs/decision-evidence/20260729-code-first-simulator-kernel-source-gap.md`
  - `Searches checked`

## Discovery trail

1. Recorded UTC start, verified clean worktree and exact candidate HEAD.
2. Listed repository files while excluding quarantined patterns. The initial broad list contained mostly unrelated v1 package files; the root decision index became the useful entry point.
3. Read the candidate’s exact root governance rather than relying on injected metadata.
4. Examined the candidate commit’s changed paths. The tip initially appeared trace-only.
5. Read the trajectory diff, which independently identified the frozen semantic parent and base. Diffed the semantic base to the candidate and discovered the five ADRs, normative spec, architecture orientation, indexes, and simulator-lineage correction.
6. Read all five ADRs, the decision index, the corrected simulator ADR, and its replacement.
7. Read the full distributed normative chapter and architecture orientation in chunks, then checked the existing package/fault-model contract and Gate 1 scope.
8. Read E01–E20, the linkage headings, frozen-candidate description, and source gaps without opening prior review artifacts.
9. Performed targeted current-authority searches for stale Router-presence, umbrella-server, seventh-package, sidecar, daemon-supervision, and deployment instructions while excluding evidence, drafts, and quarantined patterns.
10. Verified frontmatter status/date/decision-maker fields, index rows, provenance fragments, linkage anchors, semantic tree identity, candidate-only trace diff, and `git diff --check`.
11. A repository search found no checked-in raw rollout JSONL. This is consistent with the evidence rules’ selected public compaction model and was not substituted with inferred source content.
12. Rechecked clean status and exact HEAD at finish.

Misleading paths resolved:

- The trace-only candidate tip could obscure the semantic change; repository history and the trajectory’s frozen-candidate section exposed it.
- The old simulator ADR body appears currently contradictory until its frontmatter and `Supersession` section are read.
- Gate 1’s deployment deferral appears inconsistent with selected deployment mechanisms until the accepted-post-Gate-1 scope and separate implementation gate are read.
- The Gate 1 manifest is mostly unchanged background; it establishes assumptions and frozen boundaries but is not the owner of these post-Gate-1 decisions.

## Author interventions

None.

## Blockers

No blocker to accepting this candidate’s decision record was found.

Two explicit non-blocking cautions remain:

- Concrete implementation is intentionally blocked until Gate 1 prerequisites and a separate implementation-scope decision.
- The original 20260727 simulator decision has a recorded source-event gap; repository rules preserve that gap and invite maintainer reconsideration without invalidating current authority.

# Overall result: PASS

All six answers were independently discoverable. Status, supersession lineage, authority, normative ownership, fault/trust assumptions, compatibility boundary, provenance attribution, and explicit source gaps are internally consistent. The strongest stale instruction is visibly quarantined as historical by current lineage, and every unresolved implementation choice is classified as a deliberate deferral rather than silently delegated to an implementer.

This reviewer result is not self-certifying; maintainer acceptance is still required.

## Maintainer acceptance

The review result applies to the exact candidate identity above. Acceptance is
left for the named maintainer and is not inferred from the reviewer’s PASS.

| Field | Value |
|---|---|
| Maintainer | _pending maintainer review_ |
| Reviewed result | `dse-cold-20260729-02` |
| Candidate identity matches | _pending maintainer review_ |
| Gate decision | **PENDING** |
| Decision time | _pending_ |
| Rationale | _pending maintainer review_ |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_none_` |
| Superseded candidate commit | `_none_` |
| Superseded candidate content digest | `_none_` |
| Reason a rerun was required | `_none_` |

