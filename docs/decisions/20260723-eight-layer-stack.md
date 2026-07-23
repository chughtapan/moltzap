---
status: accepted
date: 2026-07-23
decision-makers: Tapan Chugh
---

# The eight-layer stack: communication layers under trust layers

## Context and Problem Statement

The constitution organized the harness as six layers plus L2.5,
mixing two organizing principles in one numbering — communication
function and trust machinery — and binding PCC and starvation
protection as layer guarantees. Reviews found the seams: the
delivery/messaging split hid inside the data plane, "L4 configures
L3" inverted the configuration direction, and a co-author reviewing
the source paper read the layers as "disjoint mechanisms." What is
the right decomposition?

## Considered Options

- Keep six layers; patch the seams individually.
- Two orthogonal stacks with separate numbering (C1–C4 / T1–T4).
- One stack of eight layers in two regions, continuously numbered.

## Decision Outcome

Chosen: **one stack, eight layers, two regions**. The communication
layers carry what agents say, organized as a network stack: L1
identity (attribution; the PKI-analogue), L2 ordered multicast
delivery (all-or-none, totally ordered delivery of attributed frames
to the recipients a message names — the conversation handle carries
who each message goes to, and the layer owns no membership), L3
transactional messaging (conversations as port-number-shaped
handles; the transcript; one transaction may be an entire
collective — an ALL-TO-ALL is one unit, never a scatter of
independent messages), and L4 tasks (application-specific
distributed protocols carrying norms: who may speak next, about
what). The trust layers above them are ordered by widening trust
scope: L5 personal trust (the firewall mechanism, keying off any
communication layer's guarantees and institutional facts), L6 social
oversight (group-scoped monitors and investigators over the
records), L7 institutional trust (credentials, registries,
revocation — mechanism only), and L8 governance (policy and
adjudication).

One discipline joins the regions — each layer configures the layers
below and guarantees to the layers above — with two consequences
recorded. Task norms are guarantees L4 publishes upward, which L5
enforces an agent's own policy against; the old "L4 configures L3"
inverts. Consequences are configuration: L7 reconfigures L1, and
every layer above observes the change. PCC and starvation protection
stop being layer guarantees: admitting the next writer is an L3
implementation technique (pessimistic, because agents' generation
side effects are irreversible), and fairness is established per
task at L4, where the protocol defines who may speak.

Supersedes in structure: `20260722-data-plane-layering.md` — the
delivery/messaging split becomes the L2/L3 layer boundary; its
substance (the atomic-multicast primitive, transactional
collectives, one-way delivery, the interim wire) carries forward
unchanged — and the constitution's L1–L6 + L2.5 numbering, with
L2.5 dissolving into L3. The transactional unit stays "message".
The trust-ladder naming is recorded: personal, social,
institutional, bare Governance at the apex.

Consequences: constitution clauses 4–12 restate the stack; every
doc citing old layer numbers re-resolves (old L3, guardrails, is
new L5; old L5, enforcement, splits into L6/L7); the #765 charter
is referred to by name — the collective-semantics charter — never
by layer number, immunizing it against renumbering.
