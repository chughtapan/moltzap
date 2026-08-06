# Blind decision review record — 86fd3f09

Result: **FAIL**, five blockers. Retained per the rule that failed attempts are
not overwritten. The record it reviewed is not admitted.

## Review identity

| Field | Value |
|---|---|
| Candidate commit | `86fd3f09` |
| Candidate | `docs/decisions/20260806-evidence-lives-in-the-brain.md` |
| Reviewer | fresh `general-purpose` subagent |
| Reviewer session | `cold-reviewer-4@session-7dd18ea8` |
| Review date | 2026-08-06 |
| Rerun of | none |

## Fresh-context attestation

The reviewer received the working directory, the candidate path, the six
questions, and quarantine-safe search syntax. No design summary, diff tour,
expected answer, or author hint; no intervention during the run.

Its own disclosure: every repo-wide search carried the two exclusions from the
first command, no quarantined content reached it, and quarantined *paths* were
visible only in `ls` output and a filename list.

## Blockers, each verified by the author before acting

**1. The prescribed move commit cannot pass its own gate.** Rewriting a
provenance link with no status change trips `checkChangelogRow` in
`.husky/pre-commit`. Reproduced directly: a planted rewrite of one link
produced `body changed, status did not, and no Record changelog row was added`.
Fifty links means fifty receipts the record never mentions, and until the
resolver is rewritten `existsSync` fails all fifty in `pnpm lint` as well.

**2. Unresolved lineage break.**
`20260728-adrs-link-source-events-and-require-blind-review.md` is `status:
accepted` and its Decision Outcome binds the ledger to the path — "Each ADR
visibly links to a source-event ledger in `docs/decision-evidence/`." The
candidate makes that false and marks nothing. Not resolvable by the authority
order: "current ADR outcomes" is one tier with no rule for two accepted records
that disagree. The `decisions` skill owns the mechanism for exactly this and it
was bypassed.

**3. The brain-side mechanism is undiscoverable in-repo.** Neither slug prefix
is named, `GBRAIN_SEARCH_EXCLUDE` has no checked-in home, and the interface
`check-shape.ts` should use to resolve a slug and validate an anchor is
unspecified. The quarantine invariant this decision exists to enforce has no
locatable enforcement point.

**4. The affected-file enumeration is incomplete** against its own "every one
changes in the same commit" claim. Four omissions confirmed present:
`docs/decisions/README.md`, `.husky/pre-commit`,
`scripts/repo/check-agent-setup.sh`, `v2/inputs/README.md`. Three path-ordered
authority lists also need a non-path replacement.

**5. The required scheduled export has no owner, cadence, destination, or
restore test** — the sole compensating control for a durability guarantee the
record deliberately surrenders.

## Non-blocking corrections, all confirmed

Context states "20 artifacts … eight compacted trajectories, ten blind-review
records, and three invalid-run records"; those addends total 21. Consequences
attributes three lost sessions to "a machine change", which no cited event
states — the ledger says only that they were absent from `~/.claude/projects`.
The `ci.yml` comment asserted brain-backed provenance resolution that does not
exist yet.

## Findings acted on immediately

Two are live defects independent of whether the move proceeds, so they were
fixed rather than filed:

**The quarantine glob had a hole.** The reviewer noticed that
`20260728-gate-1-post-merge-invalid-review-attempts.md` matched neither
`*-cold-review.md` nor `*-invalid-review.md`, so every quarantine exclusion
written to date — including the one in its own briefing — would have missed it.
Renamed to `20260728-gate-1-post-merge-invalid-review.md`; every review record
now matches a quarantine pattern.

**The `ci.yml` comment described a mechanism that does not exist.** Corrected to
say the gate resolves against the brain and provenance will once
`check-shape.ts` stops reading the filesystem.

## What the review changed about the design

Verifying blocker 4 surfaced a fact the record did not account for: **no ADR
provenance link points at a review record.** Reviews are cited only by the two
skills, the Gate 1 freeze record, and the l1-l2 ask.

The two halves of the corpus therefore have different costs. Moving reviews
alone touches roughly six references, breaks no provenance link, requires no
resolver rewrite, and leaves the source-event question answerable from the
repository — while solving the quarantine problem by construction, because a
repository-only reviewer cannot reach what is not there. Moving trajectories as
well touches roughly seventy references and fifty provenance links, and buys
the third-party-consent argument, which is real but has no live instance yet.

That split is a maintainer decision, not a reviewer finding. It is recorded
here because the review is what produced the evidence for it.
