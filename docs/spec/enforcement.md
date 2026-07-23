# L6/L7 — Social oversight and institutional trust

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

L6 and L7 turn the network's records into accountability: social oversight
(L6) detects and evidences; institutional trust (L7) executes consequences. Immutable records plus L1
identities yield non-repudiable evidence for every message's sender and
recipients; trusted monitors with a global view over records; trusted
registries disseminate norms; consequences arrive by revoking or quarantining
credentials (constitution clauses 10–11). L1–L4 render failure classes
infeasible, L5 detects at runtime, L6–L8 investigate post facto.

Goals: fix the evidence guarantee and the duty boundaries of monitors,
registries, and consequence machinery. Non-goals: L8 policy content —
who defines policies and what they prescribe (register item 7); the record
substrate's storage guarantees (`control-plane.md` owns them); who operates
monitors and registries in a given deployment.

## What is decided

- **Evidence.** Durable records are immutable and attributed: record plus
  card proves who sent what, to which conversation, at which position — for
  any party that trusts the registry and the store. Evidentiary strength
  beyond that trust anchor is the key-model question (register item 5:
  the per-frame signing path).
- **Monitors (L6)** hold a global read view over records. Their access shape
  under a content-blind plane is register item 3 — key-holding L1 parties,
  operator-mediated, or another shape — mirrored at `control-plane.md`
  invariant 7 (the plane knows exactly two caller classes).
- **Registries (L7).** Norm dissemination reuses existing marketplaces;
  reuse defers, not completes, this duty (clause 11).
- **Consequences (L7)** operate on credentials: revocation or quarantine of an
  identity's card. How consequences propagate to admission checks and
  recipients' verification is proposed for the register (`identity.md`).

## Invariants

1. Oversight reads; it never rewrites, reorders, or redacts a committed
   record.
2. Consequences act on credentials, never by silent plane behavior; their
   mechanics are open (Open questions, 3).
3. No monitor or registry sits in any delivery path; their absence changes
   no communication-layer guarantee.

## Acceptance criteria

- From records alone, a monitor reconstructs any conversation's ordered
  transcript with per-message attribution.
- Once consequence propagation (open question 3) is bound: a revoked
  identity's requests are refused per that binding, and the records show it.

## Open questions

1. Monitor access under content-blindness — register item 3.
2. Records retention and history-read scope — register item 6.
3. Revocation and quarantine mechanics, and their propagation to admission
   and verification — proposed for the register (`identity.md`).
4. Witness roles in evidence — register item 4 — and whether L6 consumes
   witness attestations at all.

## References

- `v2/VISION.md` — constitution clauses 10–11; register items 3–7.
- `control-plane.md` — transcript storage guarantees, the evidence
  substrate; `identity.md` — attribution and the card.
- `endpoints/tasks.md` — the norms registries disseminate.
