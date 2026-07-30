# Failed blind decision review — Agent Sandbox society execution

This record preserves the failed review that required the supersession repair.
It is quarantined from later blind reviews.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `dse-agent-sandbox-cold-20260730-02-fail` |
| Candidate commit | `3f4ae7a9a690ca601aab2324b14e08a492daeb3e` |
| Candidate tree | `8463f2cdcd422773118bb61c6c3d4da8d55a6eca` |
| Candidate content digest | SHA-256 `80dff7bbe36abcc2786aa3472e8d89bbd199011218cb8a94e1012ece8bcdaffc` |
| Digest scope and command | Every tracked file in the candidate commit: `git archive --format=tar 3f4ae7a9a690ca601aab2324b14e08a492daeb3e \| shasum -a 256` |
| Reviewer | Codex fresh reviewer |
| Reviewer session | `/root/fresh_adr_review_rerun` |
| Review started | `2026-07-30T23:06:57Z` |
| Review finished | `2026-07-30T23:08:22Z` |
| Review duration | 85 seconds |
| Review budget | One uninterrupted fresh-agent turn, maximum 45 minutes |
| Superseded by review run | `dse-agent-sandbox-cold-20260730-03` |
| Superseded candidate commit | `0c7a57e824a777fb3adea5789a70284f8f82b6f8` |

## Reviewer report — verbatim

> 1. What decision does this candidate make current, what problem does it
> resolve, and which statements are binding versus context or non-normative
> explanation?
>
> It makes the accepted post-Gate-1 distributed-society target current: one
> stable AgentId per direct Kubernetes Agent Sandbox with one application
> container; an exact generation-aware readiness barrier before one Effect
> dispatch; aggregate Kueue admission; regional GKE Standard reference
> deployment; one coarse Temporal workflow and non-replacing controller;
> late-bound stock OpenClaw artifacts; and per-slot read-only Secrets.
>
> It resolves how a code-first simulator can run an isolated,
> capacity-admitted agent cohort without changing Gate 1’s product-plane
> boundaries.
>
> Binding: the five accepted 20260729 ADR Decision Outcomes and
> `docs/spec/distributed-society-execution.md`, whose scope explicitly
> preserves Gate 1’s wire, identity, Router, Transcript, daemon-MCP, package,
> and completion contracts. Architecture pages are orientation/planning;
> trajectories are non-normative source-event evidence; ADR context and
> consequences are explanatory except where they state the outcome.
>
> 2. What earlier outcomes does it replace, retain, or leave untouched, and
> where does the current normative contract live?
>
> It retains the one-run lifecycle, strict readiness guarantee, one-agent
> container boundary, Layer-selected host, GKE-first/Nomad-later direction,
> Temporal+Kueue without BullMQ, local Temporal first, GKE Standard, controller
> execution, readiness-only scale gates, stock OpenClaw path, and Terraform/Helm
> direction from the recorded source events.
>
> It replaces the earlier plain-Pod/Pod-attestation implementation profile with
> direct Agent Sandbox lifecycle and Secret-bound slots. However, it does so by
> deleting the prior accepted `Pod attestation gates agent enrollment` ADR
> instead of preserving it with explicit supersession. This is a broken lineage.
>
> The current normative contract is `docs/spec/distributed-society-execution.md`;
> its accepted ADR owners are the five current 20260729 records. `v2/VISION.md`
> and root `AGENTS.md` remain higher authority.
>
> 3. What must an implementer now do or avoid, which layers or consumers are
> affected, and under what fault, trust, safety, liveness, and compatibility
> assumptions?
>
> Implement in `testbed`, not `simulator`: acquire the stack and platform;
> freeze roster; obtain aggregate Kueue admission before direct Sandbox creation;
> bind each Sandbox to exactly one Secret, AgentId, profile, and persistent state
> root; track Pod UID plus application restart count; durably record exact roster
> readiness; recheck before exactly one dispatch; record post-dispatch generation
> loss without replaying customer code.
>
> Avoid Router registration/presence/readiness semantics, per-agent Temporal
> entities, native per-Sandbox Kueue Workloads, shared roster Secrets, projected
> ServiceAccount tokens/TokenReview enrollment, extra agent containers, and
> moving Kubernetes/cloud types into `simulator`.
>
> Gate 1 assumptions remain one correct non-equivocating Registry and Router,
> one correct durable Ledger, potentially Byzantine endpoints. Kubernetes/
> controller/Kueue provide operational progress and readiness evidence, not
> MoltZap L1 trust. Pre-dispatch generation loss reacquires or fails;
> post-dispatch recovery loses in-flight work and never replays the Effect.
> Compatibility is constrained to the six-package map and unchanged Gate 1
> contracts; implementation remains blocked on the simulator handoff and
> separate first-slice decision.
>
> 4. What source-event attribution is recorded?
>
> All five current ADRs name **Tapan Chugh** as decision-maker. The initial
> trajectory cites E01 through E20 for the listed scale, lifecycle, runtime,
> host, image, isolation, orchestration, GKE, controller, evidence, surface, and
> infrastructure calls. The Agent Sandbox reconsideration trajectory cites one
> later stored user result selecting “Agent Sandbox gold.” It records source
> gaps for the later egress, durable reboot state, loss of in-flight work, and
> staging post-dispatch rejoin details.
>
> 5. Find the strongest apparent contradiction, stale instruction, or broken
> lineage elsewhere in the repository. Resolve it using the authority order or
> report it as a blocker.
>
> **Blocker: broken ADR lineage.** Semantic commit `a2b55f32…` deletes
> `docs/decisions/20260729-pod-attestation-gates-agent-enrollment.md`. Its
> parent recorded that ADR as `accepted` and indexed it. Root `AGENTS.md` is
> higher authority and requires: “Never delete, renumber, or silently rewrite
> an admitted decision”; it requires status/supersession context or a
> replacement ADR instead.
>
> No current record preserves the deleted decision’s historical reasoning,
> changes its status, identifies its successor, or states retained/replaced
> scope. The new Secret ADR explains a different implementation, but is not a
> visible supersession of the deleted accepted record. This cannot be resolved
> from the candidate and blocks landing.
>
> 6. Could a teammate implement the decision without chat or guessing?
>
> Not fully, because the broken lineage makes the prior accepted enrollment
> contract and its replacement scope undiscoverable. Deliberate deferrals
> include simulator-handoff completion and separate first-slice decision; exact
> event classes/schemas; production Temporal hosting; NanoClaw distributed
> conformance; Nomad/Slurm; warm pools/snapshots; hostile submitted-code
> isolation; concurrent-run fairness; and a 1,000–10,000-agent persistent-
> storage design. The accidental gap/blocker is deletion of the accepted
> Pod-attestation ADR rather than marking it superseded and linking its current
> replacement.
>
> Overall result: **FAIL**.

## Overall result

Result: **FAIL**

The next candidate restored the admitted decision and marks its exact
successor and retained scope explicitly.
