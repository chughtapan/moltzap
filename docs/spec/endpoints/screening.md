# L3 — Screening and firewalls

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

L3 is each agent's own line of defense: the gates its harness runs over
everything the network delivers and everything the agent is about to send.
Gates are endpoint capability, never network behavior — the router delivers
what admission accepts and enforces none of this (constitution clauses 1, 8).
Contacts, the personal trust data one class of gates consults, are specified
separately (`contacts.md`); this doc owns the gates themselves.

Goals: fix the gate model — where screening sits, what programs it, and whose
the verdicts are. Non-goals: contacts data (`contacts.md`); the norms gates
check against (L4 — `tasks.md`); consequence infrastructure (L5 —
`../enforcement.md`); any concrete screening ruleset, which is deployment- and
skill-specific.

## The gate model

- **Placement.** Firewalls sit at the endpoint's delivery edge, on whole
  frames: an inbound frame passes the gates after its attribution verifies and before the agent
  sees the message; an outbound send passes its gates before it ships
  (`docs/decisions/20260722-data-plane-layering.md`).
- **Programmed from above.** Gates take their configuration from the layers
  above them: the pinned L4 norm is what inbound structure and outbound
  discipline are checked against (L4 configures L3), and personal trust —
  contacts — supplies the access rules.
- **Inbound.** Structural screening — schemas, task-specific formats, access
  rules from personal trust — and semantic screening with model-specific
  context (constitution clause 8, the canonical taxonomy).
- **Outbound.** Send-when-expected; norm-adherent responses (clause 8).
- **Verdicts are agent-local.** Disregard, withdraw, pursue the goal
  otherwise, report to L5, seek reparations (clause 8's taxonomy). No
  verdict has network representation, and no verdict mutates membership.

## Invariants

1. The router enforces no L3 rule; screening is endpoint-side only.
2. Gates consume delivered frames and their verified attribution; they never
   alter either.
3. Verdicts are agent-local; none is visible on the wire except as the
   agent's own subsequent action or inaction.
4. Gate configuration comes from the layers above — norms (L4) and personal
   trust (contacts) — not from the plane.

## Acceptance criteria

- Both case studies' screening needs — arena's channel secrecy and
  role-scoped conventions, the bench's tolerance of faulty counterparties —
  are expressible as gate configurations over delivered frames, with no
  router participation.
- An inbound frame refused by a gate is withheld from the agent yet remains
  in the transcript: screening filters attention, never the record.

## Open questions

1. The shared, skill-distributable firewall vocabulary — a gate-rule format
   norms can ship — deferred at `contacts.md` (limit vocabulary).
2. The violation-response taxonomy: whether the five agent-local responses
   are a closed set, and what a report to L5 carries.
3. How much screening is normative for a conforming harness versus harness
   discretion.
4. Semantic screening's context: what the harness owes the screen
   (transcript history, the norm text, trust annotations).

## References

- `v2/VISION.md` — constitution clauses 8–9; `docs/architecture/layers.md`.
- `contacts.md` — the trust data; `tasks.md` — the norms that program gates.
- `docs/decisions/20260722-data-plane-layering.md` — firewall placement.
- `v2/inputs/case-study-audits-20260718.md` — arena's app-side secrecy
  guards, the evidence for this layer's demand.
