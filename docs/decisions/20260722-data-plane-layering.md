---
status: partially-superseded
date: 2026-07-22
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# Data-plane layering: atomic multicast, transactional collectives

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260722-data-plane-layering).

## Supersession

The separate data-plane surface and layered responsibility remain current. L2
multicasts opaque messages to explicit AgentIds in one Router order and owns no
conversation, membership, persistence, replay, or recovery semantics. Endpoint
communication owns conversations, reliability, protocols, and certified
actions.

`20260811-four-layer-endpoint-replicated-harness.md` removes the independent
Ledger from that endpoint layer and assigns staging, durability voting,
certified history, catch-up, and Router restart re-anchoring to fixed-member
endpoint replicas. The replacement record, `docs/spec/router.md`, and
`docs/spec/conversation-history.md` own the current data-plane layering.

## Context and Problem Statement

The physical split gave the data plane its own surface but not its
shape: the wire surface is open (`docs/spec/data-plane.md`,
question 10) and the collective-semantics clusters belong to the L2
charter (#765). What structure does the plane itself commit to —
one flat delivery surface, or layers with fixed duties?

## Considered Options

- One flat plane: ship and deliver messages; all structure chartered.
- Bind the full stack now, collective op set included.
- Layered minimum: an atomic-multicast delivery layer and a
  transactional messaging layer; the op set stays chartered.

## Decision Outcome

Chosen: **layered minimum**. Above L1's signed messages, the delivery
layer provides exactly one primitive: atomic multicast — a message is
delivered to the conversation's membership all-or-none, in the
conversation's single total order. Above it, the messaging layer
addresses by conversation (L2.5's port-number-shaped handle) and
realizes collective operations as transactions over the
per-conversation transcript: one `ALL_TO_ALL` is one transactional
unit in the record, never a sequence of independent messages.
Endpoints drive each collective's exchange with the PCC dispatch
discipline; the network contributes the primitive and the
transactional representation, nothing more. The collective
vocabulary (`START`, `ALL_GATHER`, `ALL_TO_ALL`, …) and its
semantics stay the charter's ground (#765), including whether
conversation lifecycle itself rides as a collective type. Tasks sit
above the data plane entirely: norms, contracts, and what counts as
a valid message set are endpoint (L4) concerns with no plane
representation — contact formation is expected to become a task
type (direction, not binding — `docs/spec/endpoints/tasks.md`
carries it). Endpoint firewalls act at the delivery layer and are
programmed by the layers above.

Delivery is one-way: the delivery path carries no response channel,
and an endpoint's responses — acknowledgments included — are
first-class send calls. This makes the no-reverse-callbacks rule
(constitution clause 2) explicit at the wire.

The wire is an implementation plan, not a design binding (the
pattern of `20260722-control-plane-encoding.md`): the interim
realization keeps v1's WebSocket machinery — ship as a JSON-RPC
request, delivery as v1's push path — replaceable without spec
change; the sessionless guarantees govern, and the target surface
stays open (data-plane.md question 10). The v1 machinery is a
migration baseline, not a compliant realization; its known gaps
against the recorded bounds: the push is an id-bearing call on the
connection's reverse RPC channel whose void acknowledgment is
discarded (the fix restores a strict notification, any
acknowledgment becoming a separate send call); and the v1 socket
binds identity at connect with a bearer key and carries mixed
traffic — short of the sessionless, single-credential, and
plane-split bounds. The bounds stay normative; the gaps are what
the migration closes.

Consequences: the transcript gains a representation duty —
collective operations commit as transactional units; the store can
remain a centralized database — a ledger realization stays a
preserved structural possibility, like e2e encryption; the charter
designs op semantics against atomic multicast plus a transactional
transcript, not raw message flow.

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
