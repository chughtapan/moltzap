# Invalid blind-review attempts — Gate 1 post-merge candidates

This is a non-normative audit record. It preserves five fresh-agent runs that
did not produce admissible answers while the post-merge Gate 1 candidate and
the blind-review quarantine were being made exact. No partial answer from
these runs was used to repair or coach a later reviewer.

The successful replacement is `gate-1-9712a4ed-20260728`, recorded in
`docs/decision-evidence/20260728-gate-1-9712a4ed-cold-review.md`. Adding this
review artifact does not alter or invalidate that reviewed candidate.

## Attempt register

| Run | Candidate | Reviewer and session | Start → stop | Result | Reason |
|---|---|---|---|---|---|
| `gate-1-ab11bba8-hooke-20260728` | commit `080a04064aeb88acde376ebeeb0189604c3cb4bd`, tree `ab11bba84f425b235e2bd9177b06094e82d0eca8` | `/root/blind_review_080a0406` (Hooke), `019fab55-a299-7c10-bbcf-948d47bf3807` | `2026-07-29T00:45:44.193Z` → `2026-07-29T00:54:39.937Z` | **INVALID** | The reviewer opened prior cold-review artifacts while navigating and then reported the loss of isolation. The author interrupted the run after that report. |
| `gate-1-ab11bba8-mencius-20260728` | commit `080a04064aeb88acde376ebeeb0189604c3cb4bd`, tree `ab11bba84f425b235e2bd9177b06094e82d0eca8` | `/root/blind_review_ab11bba8` (Mencius), `019fab63-07c5-7532-b806-0c34df457b71` | `2026-07-29T01:00:22.142Z` → `2026-07-29T01:07:11.559Z` | **INVALID** | The submitted prompt contained a candidate-revision line in addition to the repository root and six fixed questions. The author stopped the run when the prompt-form violation was detected. |
| `gate-1-ab11bba8-bernoulli-20260728` | commit `080a04064aeb88acde376ebeeb0189604c3cb4bd`, tree `ab11bba84f425b235e2bd9177b06094e82d0eca8` | `/root/cold_review_final` (Bernoulli), `019fab6b-2552-7810-b1b2-cec71859023f` | `2026-07-29T01:09:13.826Z` → `2026-07-29T01:14:31.729Z` | **INVALID** | The exact prompt was used, but the reviewer independently opened earlier cold-review answers. The author interrupted the run after detecting the returned content. |
| `gate-1-ab11bba8-dalton-20260728` | commit `080a04064aeb88acde376ebeeb0189604c3cb4bd`, tree `ab11bba84f425b235e2bd9177b06094e82d0eca8` | `/root/cold_review_rerun` (Dalton), `019fab70-983c-7791-baa9-f115372b58ca` | `2026-07-29T01:15:11.040Z` → `2026-07-29T01:17:41.284Z` | **INVALID** | The exact prompt was used, but a search returned headings and verdict fields from earlier cold-review artifacts. The author interrupted the run after detecting the returned output. |
| `gate-1-ee076860-zeno-20260728` | commit `3aa563ca491f385b5cc60b2ad2b87b4035c36a74`, tree `ee07686043a7812607624f3a87007d082579c808` | `/root/cold_review_candidate` (Zeno), `019fab76-3f83-7782-9ee7-9fd70ca687eb` | `2026-07-29T01:21:21.463Z` → `2026-07-29T01:22:53.612Z` | **INVALID** | The reviewer correctly avoided quarantined blind-review artifacts but treated engineering-review verdicts recorded in a candidate ADR as quarantined too. The process text did not yet distinguish blind-review output from ordinary engineering-review evidence. The reviewer stopped itself, the rule was clarified, and the semantic process edit required a new candidate and reviewer. |

## Isolation and intervention record

- Every run used a fresh agent with no forked conversation.
- No author supplied an ADR pointer, design summary, search term, expected
  answer, answer key, or response to a reviewer question.
- Interruptions occurred only after a run was already invalid because its
  prompt or returned repository content violated the gate.
- None of the five runs submitted a complete six-question answer for
  maintainer evaluation.
- The quarantine clarification was admitted in commits `3aa563ca` and
  `2782b5f3`, then reviewed from scratch as candidate tree `9712a4ed`.

## Disposition

Overall result: **INVALID**

These attempts provide process auditability only. The maintainer must evaluate
the separate exact-candidate PASS record; nothing here is positive evidence
for the Gate 1 architecture outcome.
