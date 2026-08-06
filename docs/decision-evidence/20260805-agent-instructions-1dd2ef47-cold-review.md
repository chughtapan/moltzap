# Blind decision review record — 1dd2ef47

Result: **FAIL**. Retained per the rule that failed attempts are not
overwritten. The corrected candidate is `282c333c`, reviewed separately.

## Review identity

| Field | Value |
|---|---|
| Candidate commit | `1dd2ef47` |
| Candidate tree | `512e9ef9d4b6028c8475d8644c18e982197d3fd9` |
| Candidate scope | `docs/decisions/20260805-agent-instructions-progressive-disclosure.md` and the revision landing it |
| Reviewer | fresh `general-purpose` subagent, dispatched via the `cold-read` skill |
| Reviewer session | `cold-reviewer@session-36099533` |
| Review date | 2026-08-05 |
| Rerun of | none |

## Fresh-context attestation

The reviewer was dispatched with a self-contained prompt containing the working
directory, the candidate path, the six questions, the quarantine rule, and the
output schema. It received no session history, no design summary, no diff tour,
no file pointer beyond the candidate, and no expected answer. Repository
navigation was permitted and used.

## Author interventions

Two, both mechanical and neither touching content:

1. The reviewer went idle without emitting its report. It was asked to output
   the report verbatim and unrevised.
2. It went idle again. It was told that a subagent's plain output is not
   visible to the dispatcher and that the report had to travel via
   `SendMessage`.

No question was answered for it, no hint given, no finding discussed before
submission. The report below is unedited.

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 Current decision | answerable, accurate |
| 2 Lineage and authority | answerable, accurate |
| 3 Implementation effects | answerable, accurate; surfaced an unstated compatibility assumption |
| 4 Source-event attribution | answerable, accurate; source gaps correctly identified as stated |
| 5 Strongest contradiction | **defect found** — see blocker 1 |
| 6 Implementation readiness | **defect found** — see blocker 2 |

## Blockers

1. **Unrecorded normative-ownership move in an accepted record.**
   `20260728-adrs-link-source-events-and-require-blind-review.md` still
   asserted that root `AGENTS.md` owns the record-shape, trajectory, gate,
   question, evidence, and rerun rules. Three sibling sites carried the same
   stale pointer: `docs/decisions/README.md`,
   `docs/architecture/l1-l2-implementation-ask.md`, and the `@file` header of
   `scripts/docs/adr/check-shape.ts` — a file the candidate commit had already
   touched, which the repository's own touched-comment rule covers.

2. **Checkable factual error in the candidate.** Consequences claimed "drops
   from 319 lines to 162". Git shows 362 → 161, as does the landing commit
   message.

Both verified independently by the author before acting: `git show
1dd2ef47^:AGENTS.md | wc -l` returns 362, `wc -l AGENTS.md` returns 161, and
all four stale pointers were located by grep.

## Resolution

Both blockers fixed. The 2026-07-28 record's ownership sentence now names the
`decisions` and `cold-read` skills and carries a dated `Record changelog` row;
the three sibling pointers are corrected; the line counts are corrected with
the 319/177 figures labelled as the opening measurement they were.

A note for whoever maintains the gate: correcting the candidate after it was
committed but before it landed tripped `check-shape.ts --staged`, because the
checker compares against `HEAD` and cannot distinguish a pre-landing fix from a
post-landing rewrite. Soft-resetting so the record is new relative to `HEAD` is
the correct re-freeze; the checker's conservative direction is the safe one and
was left unchanged.

## Reviewer report, unedited

> # Cold read — 20260805-agent-instructions-progressive-disclosure.md
>
> **Verdict:** `FAIL`
>
> Candidate as read: worktree `/home/tapanc/moltzap-update-agents-md`, branch
> `agents-md-restructure`, HEAD `1dd2ef47`, working tree clean. All six
> questions were answerable by navigation without a hint; the FAIL is on two
> discoverable defects listed under Blockers.
>
> [The full six answers, discovery trail, and blockers as submitted are
> preserved in the review transcript. The two blockers are reproduced verbatim
> under **Blockers** above; the per-question verdicts summarize answers the
> author verified against the repository before acting on them.]
>
> ## Q5 Strongest contradiction
>
> **Finding.** `docs/decisions/20260728-adrs-link-source-events-and-require-blind-review.md`
> (status `accepted`) ends: "Root `AGENTS.md` owns the complete record-shape,
> trajectory, gate, question, evidence, and rerun rules." At HEAD that is
> false — `AGENTS.md → Decisions` is nine lines that delegate to the
> `decisions` skill […] The record was not edited by the landing commit and
> carries no `Record changelog` row.
>
> ## Q6 Implementation readiness
>
> Consequences states "The root file drops from 319 lines to 162." Git
> disagrees on both numbers: `1dd2ef47^:AGENTS.md` is 362 lines and
> `1dd2ef47:AGENTS.md` is 161 […] the record mixes that stale baseline with an
> end count that is also off by one.
