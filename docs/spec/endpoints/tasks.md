# L4 — Tasks and norms

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

Tasks are endpoint conventions with no network representation (constitution
clause 2; the network-side task machinery dissolved —
`docs/decisions/20260720-the-network-is-a-router.md`). L4 is where
coordination meaning lives: shared collaboration norms — who may speak next,
and about what — plus contracts and the definition of a valid message set for
a context.

Goals: fix what a task and a norm are as interfaces — what a bundle binds,
what agreement means, what L4 owes L5. Non-goals: any concrete norm; the gate
machinery (`screening.md`); the collective operations norms sequence over
(the collective-semantics charter); marketplace infrastructure (reused, never built —
constitution clause 14).

## What is decided

- **Tasks are conventions.** A task is an endpoint-side agreement about what
  a set of conversations is for and which messages are valid in them. The
  network carries no task id, owner, or state; conversations stand alone,
  bound to no task.
- **Norms are versioned skill bundles** from existing marketplaces (e.g.,
  ClawHub), pinned per binding; same-version agreement is the only global
  invariant (constitution clause 8).
- **Norms are guarantees published upward.** The pinned bundle is what the
  L5 gates check inbound structure and outbound discipline against
  (clause 8); a norm
  change is a bundle version change, never a harness change.
- **Fairness is the task's.** Starvation protection is established per
  task, by the protocol that defines who may speak (clause 8;
  `docs/decisions/20260723-eight-layer-stack.md`).
- **Direction, not binding:** contact formation is expected to become a task
  type (`docs/decisions/20260722-data-plane-layering.md`) — introductions
  ride ordinary messaging under a norm, not dedicated machinery.
- **Deferred future:** formally specified contracts, analyzable for
  liveness, safety, and efficiency. The recorded direction is
  enablement-shaped artifacts — "here are your legal next moves" — which LLM
  agents consume natively (`v2/VISION.md`, What We Know).

## Invariants

1. No task or norm has network representation; the plane never reads or
   enforces either.
2. A norm binds only the participants that pinned it; the network makes no
   agreement check.
3. Norm distribution reuses existing marketplaces; v2 builds no distribution
   channel.

## Acceptance criteria

- Arena's game norms — turn order, channel secrecy, role vocabulary — are
  expressible as one versioned bundle any conforming harness could pin —
  arena's actually pinning it — with no network change and no unversioned
  drift (the v1 failure the audits recorded).
- A conversation among agents with mismatched pins fails at endpoints (L5
  gates), never in the plane.

## Open questions

1. Bundle format: what a norms bundle contains — schemas, gate rules, prose
   for the model — and its versioning discipline.
2. What "pinned per binding" binds to: a conversation, a task convention, or
   a standing relationship.
3. How same-version agreement is established and observed — a convention
   over ordinary messaging, or part of conversation start (charter-adjacent).
4. The task-type vocabulary: whether task types are themselves normed (a
   task-definition norm) or purely emergent.

## References

- `v2/VISION.md` — constitution clauses 2, 8, 14; What We Know (the
  session-types inversion).
- `screening.md` — the L5 gates that consume L4's norms; the
  collective-semantics charter — the ops norms sequence over.
- `v2/inputs/case-study-audits-20260718.md` — arena's unversioned-skill
  drift, the evidence for pinning.
