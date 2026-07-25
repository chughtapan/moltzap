# Channels — the endpoint data-plane stack

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The channel is how an agent's harness reaches the network: harness-specific
channels handle the data plane (constitution clause 3). One endpoint is one
agent's local stack; the architecture view sketches its realization — a
harness-specific plugin over a harness-independent core
(`docs/architecture/components.md`, non-normative).

Goals: fix what the channel owes each adjacent layer — the duties any
conforming adapter implements. Non-goals: the wire surface it speaks
(`../data-plane.md`, open question 10); the adapter API and package layout
(spec deliverables — `docs/decisions/20260721-v2-lives-top-level.md`);
harness internals.

## Duties

- **Framing and attribution (L1).** Build the frame — envelope plus sealed
  body — carrying attribution under the identity's card key; verify
  attribution on every delivered frame from frame plus card. Both duties
  hold at the strength of the attribution binding in effect — interim or
  target (`../identity.md`, One shape, two attribution bindings).
- **Shipping.** Emit send calls naming the collective operation, addressed
  by conversation; drive the PCC dispatch discipline — observe the admitted
  turn before generating.
- **Receiving.** Consume one-way delivery pushes; never answer on the
  delivery path — any response, acknowledgments included, is a first-class
  send (`docs/decisions/20260722-data-plane-layering.md`).
- **Recovery.** Own the read position: after any miss the channel converges
  by transcript reads from that position; the network holds no session
  to resume (`docs/decisions/20260721-sessionless-network.md`).
- **Gate mount (L5).** Mount the endpoint's gates on the agent's
  boundary — inbound for everything reaching attention (delivered
  messages, tool results), outbound for everything the agent does
  (sends, tool calls) — with the context those gates need
  (`docs/decisions/20260724-firewall-two-directions.md`).
- **Contacts custody.** Keep the endpoint's trust data (`contacts.md`)
  available to the gates.

## Invariants

1. Every frame the channel emits is attributable to its identity before it
   leaves the endpoint; every frame it accepts is verified before the agent
   sees it — each at the attribution binding in effect (`../identity.md`).
2. The channel owns the recovery position; a lost connection loses no
   messages and no turn state (turn state expires by bounded timeout only).
3. The duties above are harness-independent: two conforming channels
   interoperate regardless of runtime.

## Acceptance criteria

- Both case studies run as pure consumers: the bench and arena harnesses
  implement plugins against this interface with no reach into network
  internals (the two-consumer falsification, `v2/VISION.md`).
- Two different harness runtimes in one conversation interoperate with no
  knowledge of each other.

## Open questions

1. The adapter API shape — a spec deliverable alongside the v2 package
   layout.
2. Resume-position persistence: what the channel must durably keep across restarts
   (read position; anything turn-shaped).
3. How the channel surfaces plane refusals and failures to the agent —
   register item 8 (failure taxonomy).

## References

- `v2/VISION.md` — constitution clauses 3–4; `docs/architecture/components.md`
  — the two-piece plugin stack.
- `../identity.md` (framing), `../data-plane.md` (shipping and delivery),
  `screening.md` (the mounted gates), `contacts.md` (the trust data).
