# Blind decision review record — Agent Sandbox society execution

## Review identity

| Field | Value |
|---|---|
| Review run ID | `dse-agent-sandbox-cold-20260730-03` |
| Candidate commit | `0c7a57e824a777fb3adea5789a70284f8f82b6f8` |
| Candidate tree | `47486038cb8f6d537fe7232554a4ba69d88dfa41` |
| Candidate content digest | SHA-256 `8636948a77b711fe7eb7edf2b3b7a455af2516c898b53fad79270f0de48a2d27` |
| Digest scope and command | Every tracked file in the candidate commit: `git archive --format=tar 0c7a57e824a777fb3adea5789a70284f8f82b6f8 \| shasum -a 256` |
| Reviewer | Codex fresh reviewer |
| Reviewer session | `/root/fresh_adr_review_final` |
| Review finished | `2026-07-30T23:12:43Z` |
| Review duration | One uninterrupted read-only turn |
| Review budget | One uninterrupted fresh-agent turn, maximum 45 minutes |
| Rerun of | `dse-agent-sandbox-cold-20260730-01-invalid` and `dse-agent-sandbox-cold-20260730-02-fail` |
| Rerun reason | The first review was quarantine-contaminated. The second found a deleted admitted ADR; the candidate was repaired by restoring it with explicit supersession. |

## Reviewer report — verbatim

> 1. What decision does this candidate make current, what problem does it
> resolve, and which statements are binding versus context or non-normative
> explanation?
>
> It makes no Pod-attestation decision current: its frontmatter marks it
> `superseded`. It preserves the historical record that used a Pod-bound
> projected ServiceAccount token plus TokenReview to bind a workload to a roster
> slot, resolving the historical risk of shared roster credentials and of
> treating Kubernetes workload identity as MoltZap L1 identity.
>
> Binding current statements are the visible Supersession section:
> `20260729-kubernetes-secrets-bind-agent-slots.md` replaces projected-token/
> TokenReview enrollment with controller-created per-slot read-only Secrets,
> while retaining trust-domain separation, controller-derived slot binding, and
> release of only requesting-slot material. The former Decision Outcome,
> mechanics, and Consequences are historical context only; its exact token,
> audience, TLS, secret-envelope, and RBAC naming examples were explicitly
> implementation detail even before supersession.
>
> Verdict: PASS.
>
> 2. What earlier outcomes does it replace, retain, or leave untouched, and
> where does the current normative contract live?
>
> The candidate itself is historical; it replaces nothing. It retains the
> former Pod-attestation outcome as an admitted record and is replaced by
> accepted ADR `20260729-kubernetes-secrets-bind-agent-slots.md`. That
> replacement changes the workload-to-slot material delivery mechanism from
> projected-token/TokenReview enrollment to one controller-created, read-only
> Secret per stable Sandbox slot. It retains the L1/Kubernetes identity
> separation, controller-only roster-slot mapping, and per-slot isolation.
>
> It leaves Gate 1 identity, Router, Ledger, daemon MCP, package, and completion
> requirements untouched. The current observable post-Gate-1 contract lives in
> `docs/spec/distributed-society-execution.md`, whose Decision owners include
> the accepted Secret-slot ADR. The replacement ADR supplies the current focused
> decision outcome.
>
> Verdict: PASS.
>
> 3. What must an implementer now do or avoid, which layers or consumers are
> affected, and under what fault, trust, safety, liveness, and compatibility
> assumptions?
>
> An implementer of the current profile must resolve/validate AgentIds and
> endpoint profiles through ordinary Registry operations before Sandbox creation;
> create one run-scoped read-only Secret containing only each slot’s
> identity/profile/bootstrap material and immutable bundle references; mount it
> only into that Sandbox’s backing Pod; derive slots from controller-owned
> Sandbox metadata; and verify current Sandbox-to-Pod ownership, Pod UID, and
> restart generation when reading readiness.
>
> They must not use projected ServiceAccount tokens, TokenReview enrollment,
> shared roster Secrets, agent-claimed ordinals, Router registration/presence/
> readiness operations, or Kubernetes metadata/Secret data as a substitute for
> MoltZap L1 authentication. The primary affected implementation is
> `testbed`/controller/platform acquisition; `simulator` remains portable and
> owns no Kubernetes mechanism. Agent application containers, the Registry
> bootstrap path, endpoint profile handoff, and OpenClaw distributed runtime are
> consumers/boundaries affected by the profile.
>
> Kubernetes identity and MoltZap identity remain distinct trust domains. Gate
> 1’s trusted correct non-equivocating Registry, Router, and durable Ledger
> assumptions remain unchanged. The controller is the only slot-to-AgentId
> mapper; Kubernetes readiness is operational/current-generation evidence, not
> proof of honest behavior or L1 attribution. Generation loss before dispatch
> blocks/reacquires readiness; post-dispatch loss is typed evidence and does not
> replay customer code. This is an accepted post-Gate-1 target, so it neither
> alters Gate 1 completion nor authorizes implementation before the Gate 1
> prerequisites, immutable simulator-handoff SHA, and a separate
> implementation-scope decision.
>
> Verdict: PASS.
>
> 4. Which humans are named as decision-makers, which source events does the
> compacted trajectory cite for their calls, alternatives, reversals, and
> deferrals, and what source gaps does it explicitly record? Report only what
> the event ledger states; do not infer motives, confidence, urgency, or
> rationale.
>
> The candidate names **Tapan Chugh** as decision-maker.
>
> Its linked trajectory says the hostile-isolation and one-container boundary
> are in E09; the Pod-bound token, TokenReview, live UID/index/spec check,
> same-UID idempotency, and duplicate-UID abort are agent-authored proposals in
> E19; and E20 is the stored-user instruction to realize decisions and plan as
> ADRs. It explicitly states that no earlier retained user event independently
> selects those enrollment mechanisms or supplies a rationale; E20 directs ADR
> treatment and the engineering detail originates in the agent proposal.
>
> The trajectory’s source gaps/omissions say: hidden model reasoning, system
> prompts, tool-research payloads, credentials, and irrelevant inspection are
> omitted; the source has no per-user-message ID or parent locator; exact Kueue
> plain-Pod settings, Pod-attestation protocol, GKE topology, and controller
> failure mechanics originate in the agent-authored plan; final plan was written
> against v1 and must be translated under current v2 law; no retained source
> independently selects exact TypeScript APIs, event tags, resource sizes,
> timeout defaults, Terraform layout, production Temporal hosting, or the first
> implementation slice; and no retained source selects direct Pod-to-Pod
> NetworkPolicy posture.
>
> Verdict: PASS.

> 5. Find the strongest apparent contradiction, stale instruction, or broken
> lineage elsewhere in the repository. Resolve it using the authority order or
> report it as a blocker.
>
> The strongest apparent contradiction is the candidate’s historical instruction
> to use projected ServiceAccount tokens and TokenReview, versus the accepted
> current Secret-slot ADR and the Kubernetes/GKE reference profile’s explicit
> statement that projected tokens and TokenReview enrollment are absent. It is
> resolved, not a blocker: the candidate is unambiguously `superseded`, has a
> visible Supersession section and replacement link, the decision index says
> superseded records are historical only, and the current accepted ADR plus
> `docs/spec/distributed-society-execution.md` govern. The authority chain is
> consistent.
>
> Verdict: PASS.

> 6. Could a teammate implement the decision without chat or guessing? List
> every missing link or unresolved choice and classify each as a deliberate
> deferral or an accidental gap.
>
> Yes, for the current Secret-slot profile; no chat is needed to distinguish
> current behavior from the retained historical token profile.
>
> Deliberate deferrals / implementation details:
>
> - The immutable landed simulator-handoff SHA and separately admitted first
>   implementation scope are prerequisites before implementation.
> - Exact EventCatalog class names and schemas are assigned to that first
>   implementation scope.
> - Secret envelope/schema, bundle format/cache/path, exact Kubernetes resource
>   names, RBAC details, TypeScript APIs, timeout/resource defaults, Terraform
>   layout, and production Temporal hosting are intentionally not selected as
>   current contract.
> - Storage support for 1,000–10,000-agent reboot persistence and direct
>   Pod-to-Pod NetworkPolicy posture require later decisions.
>
> Accidental gaps: none found in the retained ADR’s supersession lineage or the
> current implementation-facing contract.
>
> Verdict: PASS.

> Review record:
>
> - Reviewer identity: `/root/fresh_adr_review_final`, fresh independent Codex
>   agent session.
> - Candidate: commit `0c7a57e824a777fb3adea5789a70284f8f82b6f8`; tree
>   `47486038cb8f6d537fe7232554a4ba69d88dfa41`.
> - UTC finish: `2026-07-30T23:12:43Z`. The review was one uninterrupted
>   read-only turn; no author intervention occurred.
> - Reproducible content digest:
>   `8636948a77b711fe7eb7edf2b3b7a455af2516c898b53fad79270f0de48a2d27`, from
>   `git archive --format=tar HEAD | shasum -a 256` at the candidate commit.
>   Scope: every tracked file in that commit, excluding Git metadata by
>   `git archive` semantics.
> - Fresh-context attestation: I received only repository root, candidate
>   identity, quarantine instruction, and the six fixed questions; I did not
>   receive a design summary, file pointer, search term, expected answer, answer
>   key, or author assistance. I did not open, read, or search any
>   `*-cold-review.md` or `*invalid-review*` artifact. The only listing of the
>   evidence directory used a filename filter that pruned those artifacts.
> - Independently discovered evidence: repository and `AGENTS.md` /
>   `v2/AGENTS.md`; decision index; candidate ADR; accepted Secret-slot ADR;
>   post-Gate-1 distributed-execution spec; v2 constitution; linked compacted
>   trajectory; linked accepted distributed-execution ADRs; candidate
>   diff/history.
> - Discovery trail: repository root → governing instructions →
>   non-quarantined documentation inventory and candidate diff → decision index
>   → candidate ADR → its superseding ADR → normative specification → linked
>   trajectory and source gaps → related accepted ADRs → digest and whitespace
>   check.
> - Checks: `git diff --check HEAD^ HEAD` passed; worktree was clean.
> - Blockers: none.
> - Overall result: **PASS**.

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| `_none_` | `_none_` | `_none_` |

## Overall result

Result: **PASS**

The fresh reviewer found the supersession lineage explicit, the normative
contract discoverable, and no accidental implementation gap.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The draft PR
is the maintainer-admission point.

| Field | Value |
|---|---|
| Maintainer | `_pending_` |
| Reviewed result | `dse-agent-sandbox-cold-20260730-03` |
| Candidate identity matches | `yes` |
| Gate decision | `_pending_` |
| Decision time | `_pending_` |
| Rationale | `_pending_` |
