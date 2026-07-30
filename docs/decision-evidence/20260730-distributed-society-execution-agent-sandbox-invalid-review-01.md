# Invalid blind decision review — Agent Sandbox society execution

This record preserves a procedurally invalid blind-review attempt. Its
substantive findings were neither returned to the author nor used by the valid
rerun. This file is a quarantined input for future blind reviews.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `dse-agent-sandbox-cold-20260730-01-invalid` |
| Candidate commit | `b62247175d39331d60a24bd6b07947729fdb6b0c` |
| Candidate tree | `b55e5c9d93cbe1cf9084a825cb2ee8ecdb86ad98` |
| Candidate content digest | SHA-256 `4bb002a7403be6b90183641d3c6f80dc273f805a652c63d98ea76fcc1ff4cbcd` |
| Digest scope and command | Git archive of the candidate commit: `git archive --format=tar b62247175d39331d60a24bd6b07947729fdb6b0c \| shasum -a 256` |
| Reviewer | Codex fresh reviewer |
| Reviewer session | `/root/fresh_adr_review` |
| Review finished | `2026-07-30T23:01:57Z` |
| Review duration | Not reported |
| Review budget | One uninterrupted fresh-agent turn, maximum 45 minutes |
| Superseded by review run | `_pending_` |

## Reviewer invalidation — verbatim

> The review is invalidated. A repository search intended to exclude
> quarantined files nevertheless returned content from
> `docs/decision-evidence/20260729-distributed-society-execution-cold-review.md`.
> Per the review gate, I stopped substantive review immediately.

> 1. What decision does this candidate make current, what problem does it
> resolve, and which statements are binding versus context or non-normative
> explanation?
>
> Not assessed to a valid-review standard after quarantine contamination.
>
> 2. What earlier outcomes does it replace, retain, or leave untouched, and
> where does the current normative contract live?
>
> Not assessed to a valid-review standard after quarantine contamination.
>
> 3. What must an implementer now do or avoid, which layers or consumers are
> affected, and under what fault, trust, safety, liveness, and compatibility
> assumptions?
>
> Not assessed to a valid-review standard after quarantine contamination.
>
> 4. Which humans are named as decision-makers, which source events does the
> compacted trajectory cite for their calls, alternatives, reversals, and
> deferrals, and what source gaps does it explicitly record? Report only what
> the event ledger states; do not infer motives, confidence, urgency, or
> rationale.
>
> Not assessed to a valid-review standard after quarantine contamination.
>
> 5. Find the strongest apparent contradiction, stale instruction, or broken
> lineage elsewhere in the repository. Resolve it using the authority order or
> report it as a blocker.
>
> Blocker: quarantine contamination invalidates the review; a different fresh
> reviewer must restart.
>
> 6. Could a teammate implement the decision without chat or guessing? List
> every missing link or unresolved choice and classify each as a deliberate
> deferral or an accidental gap.
>
> Not assessed to a valid-review standard after quarantine contamination.

> Review identity: `/root/fresh_adr_review` fresh agent session. Candidate
> commit/tree: `b62247175d39331d60a24bd6b07947729fdb6b0c` /
> `b55e5c9d93cbe1cf9084a825cb2ee8ecdb86ad98`.
>
> Candidate content digest: SHA-256
> `4bb002a7403be6b90183641d3c6f80dc273f805a652c63d98ea76fcc1ff4cbcd`, from:
>
> ```sh
> git archive --format=tar b62247175d39331d60a24bd6b07947729fdb6b0c | shasum -a 256
> ```
>
> Scope: complete archived candidate commit. Finish observed at
> `2026-07-30T23:01:57Z`; start/duration were not independently timestamped
> before invalidation.
>
> Fresh-context attestation: I had no prior candidate review, author tour,
> expected answer, or prior review output. This attestation does not cure the
> contamination.
>
> Discovery trail: repository root → `AGENTS.md` / `v2/AGENTS.md` → decision
> index → current Agent Sandbox ADR and trajectory → distributed-execution spec
> and related ADRs. The invalidating command was:
>
> ```sh
> rg -n --glob '!*-cold-review.md' --glob '!*invalid-review*' 'plain Pod|plain-Pod|restartPolicy: Never|one Workload per Sandbox|Kueue plain' docs v2 --glob '*.md'
> ```
>
> Despite the exclusion intent, its output included quarantined cold-review
> content. No author interventions occurred.

## Author interventions

The author provided no design hint, answer, or clarification. The invalidated
review did not provide substantive results to the author.

## Overall result

Result: **INVALID**

The reviewer searched a quarantined artifact despite an exclusion glob, so a
different fresh reviewer must restart. The candidate remains unchanged.
