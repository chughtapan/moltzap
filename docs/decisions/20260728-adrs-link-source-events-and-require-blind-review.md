---
status: accepted
date: 2026-07-28
decision-makers: Tapan Chugh
---

# ADRs link source events and require blind review

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-adrs-link-source-events-and-require-blind-review).

## Context and Problem Statement

An ADR makes a decision durable, but polished prose can hide which
parts came from a human message, an agent proposal, or a later
repository edit. Agents then risk treating generated rationale as a
human statement or silently supplying a reason that the stored session
never recorded.

The first Gate 0 review also recorded only a PASS summary. It did not
preserve the exact candidate, questions, answers, reviewer isolation, or
navigation trail, so it could not demonstrate that the repository was
actually understandable without author guidance.

## Decision Outcome

Chosen: **every ADR links to source-event provenance and every ADR
change passes a blind teammate review before landing**.

- Each ADR visibly links to a source-event ledger in
  `docs/decision-evidence/`. Every retained event carries its source
  session, native locator, UTC timestamp, stored actor role, and literal
  excerpt.
- The ledger preserves spelling, hedges, questions, and option labels.
  Terse replies include the directly preceding agent prompt. Agent
  proposals and mechanical repository effects remain separate events.
- `decision-makers` identifies the humans accountable for admitting the
  choice. It does not turn the ADR's rationale into a human quote or
  prove who controlled the stored session account.
- Trajectories are curated, non-normative evidence rather than raw
  transcripts. They do not infer motive, confidence, urgency,
  causality, or rationale. Missing historical context is a source gap,
  never a reconstruction from ADR prose.
- After an ADR or its lineage, provenance, normative owner, or manifest
  trace changes, a fresh teammate receives only the exact candidate
  repository and the fixed root review questions. The prompt provides
  no ADR name, file pointer, diff tour, search term, expected answer, or
  out-of-band index.
- The reviewer independently reports answers, discovered paths, and the
  strongest apparent contradiction. A candidate-bound artifact
  preserves the exact prompt, unedited answers, discovery trail,
  isolation attestation, interventions, verdicts, and maintainer
  disposition.
- A wrong, contradictory, unfindable, coached, or guess-dependent answer
  blocks landing. A substantive correction requires a new candidate and
  a different fresh reviewer.

The `decisions` skill owns the record-shape, trajectory, gate, evidence,
and rerun rules, with provenance rules in its `references/provenance.md`;
the six questions live in the `cold-read` skill's
`references/questions.md`. Mechanical record shape is enforced by
`scripts/docs/adr/check-shape.ts`.

## Consequences

Decision work now carries an explicit source trail and an organizational
comprehension test. Agents can show the named human the exact event
behind a provisional call or a missing source instead of treating the
ADR as self-justifying, but neither condition permits an agent to ignore
a current outcome.

Review takes additional time and produces checked-in evidence. This is
intentional: a design that can be understood only after an author points
to the right file has not passed the repository-native design gate.

The existing ADR corpus links to source-faithful compactions of the
stored Claude and Codex sessions. The earlier unstructured Gate 0 PASS
remains historical evidence and does not satisfy the new blind teammate
gate.

## Record changelog

Point corrections that leave the Decision Outcome intact. A change that alters
the outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-05 | Normative owner repointed: the record-shape, trajectory, gate, evidence, and rerun rules moved from root `AGENTS.md` to the `decisions` skill, provenance rules to its `references/provenance.md`, and the six questions to the `cold-read` skill's `references/questions.md`, under `20260805-agent-instructions-progressive-disclosure.md`. The requirement to link source events and pass a blind gate is unchanged. |
