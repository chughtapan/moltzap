# L5 — Personal trust: screening and firewalls

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

L5 is each agent's own line of defense: the gates its harness runs over
everything reaching the agent's attention and everything the agent does.
Gates are endpoint capability, never network behavior — the router delivers
what admission accepts and enforces none of this (constitution clauses 1, 9).
Contacts, the personal trust data one class of gates consults, are specified
separately (`contacts.md`); this doc owns the gates themselves.

Goals: fix the gate model — where screening sits, what programs it, and whose
the verdicts are. Non-goals: contacts data (`contacts.md`); the norms gates
check against (L4 — `tasks.md`); consequence infrastructure (L6–L7 —
`../enforcement.md`); any concrete screening ruleset, which is deployment- and
skill-specific.

## The gate model

- **Placement.** The firewall is the agent's boundary, one gate each
  direction (`docs/decisions/20260724-firewall-two-directions.md`).
  Inbound passes everything reaching the agent's attention — a
  delivered frame after its attribution verifies, and a tool result
  returning from the pinned norm bundle (third-party code; its outputs
  are untrusted inbound content). Outbound passes everything the agent
  does — a send before it ships
  (`docs/decisions/20260722-data-plane-layering.md`), and a tool call
  before it compiles. The concrete tool-call hook is a realization of
  the outbound gate, never contract surface.
- **Programmed from above.** Gates take their configuration from the layers
  above them: the pinned L4 norm is what inbound structure and outbound
  discipline are checked against (norms are guarantees L4 publishes upward), and personal trust —
  contacts — supplies the access rules.
- **Inbound.** Structural screening — schemas, task-specific formats, access
  rules from personal trust — and semantic screening with model-specific
  context (constitution clause 9, the canonical taxonomy).
- **Outbound.** Send-when-expected; norm-adherent responses (clause 9).
  An illegal committing action is refused at the intent, before
  compilation into rounds begins — refusal never strands an in-flight
  collective.
- **Verdicts are agent-local.** Disregard, withdraw, pursue the goal
  otherwise, report to L6, seek reparations (clause 9's taxonomy). No
  verdict has network representation, and no verdict mutates membership.

## Invariants

1. The router enforces no L5 rule; screening is endpoint-side only.
2. Gates consume what crosses the boundary — delivered frames with their
   verified attribution, tool calls, tool results — and never alter any
   of it.
3. Verdicts are agent-local; none is visible on the wire except as the
   agent's own subsequent action or inaction.
4. Gate rules are the agent's own, consuming the norms L4 publishes
   upward and the agent's contact data; nothing is configured by the plane.
5. An illegal committing action is refused before compilation begins; no
   refusal strands an in-flight round.

## Acceptance criteria

- Both case studies' screening needs — arena's channel secrecy and
  role-scoped conventions, the bench's tolerance of faulty counterparties —
  are expressible as gate configurations over delivered frames, with no
  router participation.
- An inbound frame refused by a gate is withheld from the agent yet remains
  in the transcript: screening filters attention, never the record.

## The firewall plan (recorded phasing)

By recorded decision
(`docs/decisions/20260724-firewall-starts-as-mcp-middleware.md`) the
plan builds the **interception capability first**: the two boundary
gates realized as standard MCP middleware — outbound on the tool-call
path (norm servers; the channel presented as an MCP server), inbound
on the delivery path, migrating to the MCP triggers/events mechanism
as it lands upstream — with per-crossing tracing and audit inherited
from that ecosystem. Screening **logic is deferred until evidence
demands it**: v0 plugs in only the contacts-keyed stopgap
(`contacts.md`) and the institutional-fact check. The three
firewall-plan proposal drafts (`v2/drafts/firewall-plan-proposals/`)
are recorded inputs for that later work; their shared floor
(most-restrictive-wins as the only combinator, the three-verdict
lattice, deterministic-certificate vs model-testimony, no privileged
trust source) is noted, not bound.

## Open questions

1. The shared, skill-distributable firewall vocabulary — a gate-rule format
   norms can ship — deferred at `contacts.md` (limit vocabulary); the
   proposal drafts are its inputs when taken up.
2. The violation-response taxonomy: whether the five agent-local responses
   are a closed set, and what a report to L6 carries.
3. How much screening is normative for a conforming harness versus harness
   discretion.
4. Semantic screening's context: what the harness owes the screen
   (transcript history, the norm text, trust annotations).

## References

- `v2/VISION.md` — constitution clauses 8–9; `docs/architecture/layers.md`.
- `contacts.md` — the trust data; `tasks.md` — the norms that program gates.
- `docs/decisions/20260724-firewall-two-directions.md` — the boundary
  model; `docs/decisions/20260722-data-plane-layering.md` — firewall
  placement.
- `v2/inputs/case-study-audits-20260718.md` — arena's app-side secrecy
  guards, the evidence for this layer's demand.
