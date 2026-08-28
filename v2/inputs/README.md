# V2 evidence and provenance

This directory contains the evidence base and immutable-source handoffs
used by the v2 track. Evidence identifies source events and repository
effects behind a decision; it does not supply an explanation that the
sources did not state, or override agent law, current ADR outcomes, or
normative specs.

Read authority in this order:

1. `AGENTS.md` and `v2/VISION.md`;
2. current outcomes in `docs/decisions/`, including retained portions
   of partially-superseded records;
3. normative `docs/spec/`;
4. `docs/architecture/`;
5. this evidence.

Historical proposals live under `v2/drafts/` and carry explicit
non-normative banners.

## Founding evidence

Produced by the 2026-07-17/18 research and audit sessions:

- `landscape-sweep-20260717.md` — six-area prior-art survey: agent
  protocols, group communication, protocols-as-code, LLM guardrails,
  agent identity, and tamper-evident records.
- `v1-code-audit-20260717.md` — v1 mapped against identity,
  collectives/dispatch, endpoint guardrails, experiment infrastructure,
  and protocol extensibility.
- `debt-inventory-20260718.md` — open-issue dispositions and
  enforcement, conformance, documentation, and release gaps.
- `strict-enforcement-debt-20260718.md` — exact strict-boundary
  violation counts, retained as architecture-tool acceptance fixtures.
- `case-study-audits-20260718.md` — how the propagation bench and arena
  consume v1 and what v2 owes them as clean external consumers.

## Decision evidence

Repository-wide decision evidence lives under
[`docs/decision-evidence/`](../../docs/decision-evidence/), where ADR
links can be checked by the documentation toolchain. It contains
non-normative source-event ledgers and reproducible blind-review records;
its
[`README.md`](../../docs/decision-evidence/README.md) defines fidelity,
attribution, privacy, and correction rules.

- [`20260720-20260727-v2-design-origins-trajectory.md`](../../docs/decision-evidence/20260720-20260727-v2-design-origins-trajectory.md)
  compacts the located pre-Gate-1 Claude session events and keeps
  repository effects and source gaps separate.
- [`20260728-gate-1-engineering-review-trajectory.md`](../../docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md)
  compacts the located Gate 1 Codex session events with native source
  locators and literal excerpts.
- [`cold-review-template.md`](../../docs/decision-evidence/cold-review-template.md)
  records a fixed-prompt, fresh-context review against an exact
  candidate identity.

## Source handoffs

- `agentcoordbench-messaging-calendar-handoff-20260827.md` — non-normative
  downstream instructions for a later distinct addressed-messaging/shared-
  calendar condition. Its artifact pins remain unset until qualification.
- `simulator-handoff-20260728.md` — the blocking provenance manifest for
  the v2 simulator port. It remains `pending` and its landed SHA remains
  unset until the source rewrite is fully tracked, rebased, reviewed,
  landed on `main`, and green under every required gate.

A worktree path, branch name, current HEAD, patch, stash, or untracked
file set is not a source handoff. The manifest may become `verified`
only after it names a reconstructible landed commit and records the
evidence required by
`docs/decisions/20260728-simulator-is-the-system-driver.md`.

The source research paper referenced by `v2/VISION.md` is not committed
while under anonymous review.
