# Blind decision review record

Use this template after an admitted architecture decision record is
added or changed. The review tests whether a teammate can discover,
understand, challenge, and apply the decision from the repository
alone.

The reviewer receives a clean checkout at the candidate revision and
the six questions below. Checked-in entry points and repository-native
indexes are ordinary discoverable repository content. Earlier
`*-cold-review.md` records and invalid-review records are quarantined:
their paths may appear during navigation, but the reviewer must not
open, read, or search their contents before submitting the new result.
The reviewer is not given an out-of-band design summary, diff tour,
architecture decision record or file pointer, search term, expected
answer, or answer key.

Keep the reviewer's answers verbatim. Do not repair, summarize, or
reinterpret them before the maintainer evaluates the result.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `_fill_` |
| Candidate commit | `_fill exact commit SHA_` |
| Candidate tree | `_fill exact tree SHA_` |
| Candidate content digest | `_fill algorithm and digest_` |
| Digest scope and command | `_fill exact scope and reproducible command_` |
| Reviewer | `_fill human name or agent identity_` |
| Reviewer session | `_fill fresh-session identifier_` |
| Review started | `_fill ISO 8601 timestamp_` |
| Review finished | `_fill ISO 8601 timestamp_` |
| Review duration | `_fill elapsed time_` |
| Review budget | `_fill budget fixed before the review_` |
| Rerun of | `_none_` or `_fill prior review run ID_` |
| Rerun reason | `_none_` or `_fill reason the prior result became invalid_` |

## Fresh-context attestation

The reviewer attests:

- [ ] I did not author or reconcile the candidate decision.
- [ ] I received no inherited conversation, summary, memory, private
      state, or earlier blind-review output about the candidate.
- [ ] I received only the clean candidate checkout and the fixed
      questions in this template.
- [ ] I received no out-of-band tour, decision or file pointer, search
      term, expected answer, or answer key.
- [ ] I navigated the repository independently. I may have used
      checked-in entry points, repository-native indexes, ordinary
      search, and repository history after discovering them myself.
- [ ] I did not open, read, or search the contents of an earlier
      cold-review or invalid-review record. If an artifact path appeared
      in a listing or history, no answer or verdict from that
      quarantined record was returned. Engineering-review evidence
      recorded in candidate ADRs or trajectories is allowed.
- [ ] I did not ask the author for help or modify the candidate before
      submitting these answers.
- [ ] The author interventions recorded below are complete.

An unchecked attestation or a material author hint invalidates the
review. “Not discoverable” is a valid answer and must not be repaired
with an author hint.

## Fixed questions and verbatim answers

The six questions are **not** restated here. They live in
`.claude/skills/cold-read/references/questions.md`, which is their normative
owner. A second copy would drift, and the drift would be invisible — the
same failure that stopped `AGENTS.md` paraphrasing `v2/VISION.md`.

Record one section per question, numbered 1 to 6, each carrying the
reviewer's unedited answer and the paths and headings it independently
discovered.

## Discovery trail

Record how the reviewer found the relevant material, including failed
or misleading paths. This is a concise navigation trail, not a
retrospective ideal reading order.

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | `_fill_` | `_fill_` | `_fill_` |

## Author interventions

A valid blind review normally records `none`. Record every accidental
or deliberate interaction, including hints that did not change an
answer.

| Time | Intervention | Effect on review |
|---|---|---|
| `_none_` | `_none_` | `_none_` |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| `_none_` | `_none_` | `_none_` | `_none_` |

## Overall result

Result: **_PASS, FAIL, or INVALID_**

Rationale:

_Fill with the reviewer's overall rationale. PASS requires all six
answers to be accurate and independently discoverable, complete
lineage and authority, discoverable source-event attribution, no unresolved
contradiction, and no binding choice that an implementer must invent._

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity
above and records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_fill_` |
| Reviewed result | `_fill review run ID_` |
| Candidate identity matches | `_yes or no_` |
| Gate decision | `_ACCEPTED or REJECTED_` |
| Decision time | `_fill ISO 8601 timestamp_` |
| Rationale | `_fill_` |

## Rerun identity

If the review fails or becomes stale, preserve this record and start a
new one with a new run ID, exact candidate identity, and fresh reviewer
session. Record the prior run ID and rerun reason in the new record.
Do not overwrite a failed, invalid, or superseded review.

| Field | Value |
|---|---|
| Superseded by review run | `_none_` or `_fill new review run ID_` |
| Superseded candidate commit | `_none_` or `_fill exact commit SHA_` |
| Superseded candidate content digest | `_none_` or `_fill algorithm and digest_` |
| Reason a rerun was required | `_none_` or `_fill_` |
