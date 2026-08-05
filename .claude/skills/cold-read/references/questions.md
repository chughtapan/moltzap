# Blind review questions for a decision record

Passed to `cold-read` as `--questions`. Ask these verbatim. Do not add
context, name the author, or hint at an expected answer — a material hint
invalidates the run.

1. What decision does this candidate make current, what problem does it
   resolve, and which statements are binding versus context or non-normative
   explanation?

2. What earlier outcomes does it replace, retain, or leave untouched, and where
   does the current normative contract live?

3. What must an implementer now do or avoid, which layers or consumers are
   affected, and under what fault, trust, safety, liveness, and compatibility
   assumptions?

4. Which humans are named as decision-makers, which source events does the
   compacted trajectory cite for their calls, alternatives, reversals, and
   deferrals, and what source gaps does it explicitly record? Report only what
   the event ledger states; do not infer motives, confidence, urgency, or
   rationale.

5. Find the strongest apparent contradiction, stale instruction, or broken
   lineage elsewhere in the repository. Resolve it using the authority order or
   report it as a blocker.

6. Could a teammate implement the decision without chat or guessing? List every
   missing link or unresolved choice and classify each as a deliberate deferral
   or an accidental gap.

## Quarantine

Earlier `*-cold-review.md` and `*-invalid-review.md` records stay checked in
for auditability, but they are **quarantined inputs**. Do not open, read, or
search their contents during a run. Seeing a path in a directory listing or in
history is fine; reading one is not.

If any command returns an answer or a verdict from one of those records,
invalidate the run and start a fresh one. Engineering-review evidence recorded
inside the candidate record or its trajectory is ordinary evidence, not a
quarantined review.

## Result

PASS requires all six answers accurate and discoverable, with consistent
status, lineage, authority, assumptions, normative ownership, and source-event
attribution.

Any wrong or unfindable answer, broken source locator, unresolved
contradiction, invented binding choice, or need for an author hint is FAIL and
blocks landing. `Not discoverable` is a valid answer and usually a finding
about the record.

A maintainer accepts the result. Reviewer prose is not self-certifying.
