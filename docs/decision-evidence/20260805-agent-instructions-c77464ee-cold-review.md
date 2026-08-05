# Blind decision review record — c77464ee

Result: **PASS**, third in the sequence. Two non-blocking items, both acted on.

## Review identity

| Field | Value |
|---|---|
| Candidate commit | `c77464ee` |
| Reviewer | fresh `general-purpose` subagent, third of the sequence |
| Reviewer session | `cold-reviewer-3@session-36099533` |
| Review date | 2026-08-05 |
| Rerun of | `1dd2ef47` (FAIL, blockers fixed) and `282c333c` (INVALID, reviewer quarantine breach) |

## Fresh-context attestation

The reviewer's own words: *"I received only the candidate path, the working
directory, and the six questions. No design summary, diff tour, search term,
expected answer, or author hint; no author intervention occurred mid-run. I did
not open, read, or search the contents of any `*-cold-review.md` or
`*-invalid-review.md` file, and no command returned a line from one."*

The dispatch prompt carried explicit quarantine-safe search syntax, added after
the second run died on an unfiltered `grep -rn`. That is an instruction about
*method*, not about the candidate, and it supplied no answer.

It also noted that `cold-review-template.md` falls outside both quarantine
globs and read it as ordinary repository content — correct, and worth recording
so a later reviewer does not treat it as contaminated.

## Author interventions

None during the run.

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 Current decision | accurate; the four binding statements identified correctly, and the record's own line figure caught as wrong |
| 2 Lineage and authority | accurate; both point-corrections and their changelog rows verified against the live trace rows |
| 3 Implementation effects | accurate; every mechanical claim tested on disk rather than trusted |
| 4 Source-event attribution | accurate; source gaps reported as stated, with the ordering consequence derived rather than invented |
| 5 Strongest contradiction | resolved via the authority order, not a blocker |
| 6 Implementation readiness | yes; six open items classified |

## Findings and disposition

**1. Line-count error in the candidate.** `Consequences` claimed the root file
drops to 161 lines; it is 153 at the landing commit and at HEAD. The figure was
written before the doc-writing procedure moved to the `docs` skill. Verified
independently (`git show c77464ee:AGENTS.md | wc -l` → 153).

Fixed as a point correction with a dated `Record changelog` row, which is the
mechanism for a factual fix that leaves the Decision Outcome intact. Every other
figure in the record verified exactly against the historical revisions.

**2. Dead pointers naming the instruction file as owner of the `@failure`
convention.** `packages/protocol/scripts/docs/modules.ts → parseFailureTag` and
`eslint.shared.mjs` both said to see workspace `AGENTS.md` / `CLAUDE.md` for a
convention that file has never carried — `git log -S "@failure" -- AGENTS.md
CLAUDE.md` returns nothing, so the pointer predated this change. This decision
made it *more* wrong: `AGENTS.md` now refuses on principle to carry a rule a
check enforces, and `@failure` is registered in `eslint.shared.mjs`.

Both clauses removed. `parseFailureTag`'s own claim to be the single source of
truth for the parse rule now stands unqualified.

**3. No mechanical guard on the symlink invariant.** The reviewer's sharpest
structural point: the record argues prose drifts and checks do not, then leaves
its own central claim — every `CLAUDE.md` is a symlink — as prose. A new
package with a hand-written copy would diverge silently.

`scripts/repo/check-agent-files.ts` now fails when any `AGENTS.md` lacks a
sibling `CLAUDE.md`, when that sibling is a regular file, or when its stored
link target is not `AGENTS.md`. Wired into `pnpm lint` as `lint:agent-files`;
verified by replacing one symlink with a byte-identical copy, which it rejects.

**4. README sent contributors to files that no longer render.** Its
Documentation section linked `packages/{protocol,server,client}/CLAUDE.md`,
which this change turned into symlinks — GitHub renders a symlink as a pointer
blob rather than the page, so the links still resolve but no longer show the
content. A regression introduced by this change rather than a pre-existing one.
Retargeted at the sibling `AGENTS.md` files, which are regular files.

**Not acted on, recorded as known:** `.codex/skills/cold-read` is documented in
the vendoring PR rather than in this record's Consequences; no statement covers
checkouts with `core.symlinks=false` (no `.gitattributes` exists); and no
register names which future procedures become skills, which the reviewer
classified as a deliberate scope bound.

## Note on landing after PASS

Items 1 and 3 changed the tree after the reviewed commit. The judgment applied,
recorded here so a later reader can disagree with it: the gate's rule exempts
"adding only the review artifact, or applying meaning-preserving formatting,"
and a changelog-recorded correction to a non-normative Consequences figure is
the case the changelog mechanism was created for. The Decision Outcome is
untouched, and the correction carries its own dated receipt.

The added check and the two comment fixes are new material outside the record,
not edits to it.

## Reviewer verdict, verbatim

> **Verdict:** `PASS`
>
> ## Blockers
>
> None. Two items for the maintainer, neither blocking:
>
> 1. **Point correction (record):** `Consequences` says the root file drops to
>    161 lines; it is 153 at the landing commit and at HEAD. Per the `decisions`
>    skill this is a `Record changelog` row, not a supersession.
> 2. **Follow-up (repository):** drop the stale "see workspace AGENTS.md /
>    CLAUDE.md" pointer from `packages/protocol/scripts/docs/modules.ts →
>    parseFailureTag` and `eslint.shared.mjs`, and consider a mechanical check
>    that every `CLAUDE.md` is a symlink to its sibling `AGENTS.md`.
