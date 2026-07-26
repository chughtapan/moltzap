---
status: accepted (scope superseded in part — see 20260724-collectives-are-ledger-transactions.md)
date: 2026-07-22
decision-makers: Tapan Chugh
---

# Data-plane layering: atomic multicast, transactional collectives

## Context and Problem Statement

The physical split gave the data plane its own surface but not its
shape: the wire surface is open (`docs/spec/data-plane.md`,
question 10) and the collective-semantics clusters belong to the L2
charter (#765). What structure does the plane itself commit to —
one flat delivery surface, or layers with fixed duties?

## Considered Options

- One flat plane: ship and deliver frames; all structure chartered.
- Bind the full stack now, collective op set included.
- Layered minimum: an atomic-multicast delivery layer and a
  transactional messaging layer; the op set stays chartered.

## Decision Outcome

Chosen: **layered minimum**. Above L1's signed frames, the delivery
layer provides exactly one primitive: atomic multicast — a frame is
delivered to the conversation's membership all-or-none, in the
conversation's single total order. Above it, the messaging layer
addresses by conversation (L2.5's port-number-shaped handle) and
realizes collective operations as transactions over the
per-conversation transcript: one ALL-TO-ALL is one transactional
unit in the record, never a sequence of independent messages.
Endpoints drive each collective's exchange with the PCC dispatch
discipline; the network contributes the primitive and the
transactional representation, nothing more. The collective
vocabulary (CONVERSATION-START, ALL-GATHER, ALL-TO-ALL, …) and its
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
