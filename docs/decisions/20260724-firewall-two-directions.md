---
status: partially-superseded
date: 2026-07-24
decision-makers: Tapan Chugh
superseded-by: 20260728-model-surface-is-start-reply-listen.md
---

# The firewall is the agent's boundary: two directions, everything crosses

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260724-firewall-two-directions).

## Supersession

The core Decision Outcome — one inbound and one outbound agent-boundary
direction — remains current. Later accepted records supersede body
phrases about a generic plain-send path, pinned norm-bundle tools, and
norm-bundle tool results; those phrases are historical context, not
Gate 1 surfaces.

Gate 1 makes the crossings concrete. A verified committed record and
live grant cross inbound as one MCP turn-ready notification. The
runtime's `reply` selection crosses outbound before the endpoint
compiles protocol messages. Peer protocol proposals and signature
requests cross inbound through deterministic endpoint validation, and
an endpoint signature crosses outbound only after that validation.
There is no generic send tool and no Gate 1 norm-bundle MCP surface;
`OpenFloorV1` is built into the endpoint. Runtime-specific semantic L5
screening across local MCP remains explicitly deferred.

## Context and Problem Statement

The norm-form hypothesis
(`docs/decisions/20260724-norms-are-mcp-skill-bundles.md`) created a
new crossing at the endpoint: the agent calls tools on its pinned norm
bundle, and results return from it — third-party code either way. The
L5 contract promised two gates scoped to messages, which left tool
traffic outside every promised guarantee: a read-only projection query
never becomes a message, so no named gate would ever see it. Does
tool-call screening become a third named slot, or is the two-slot
contract wrong-scoped?

## Considered Options

- A named third slot per counterparty type (peer messages, norm-bundle
  actions, and one more for each future counterparty).
- Two slots, generalized: the firewall is the agent's boundary,
  defined by direction, and everything crosses it.

## Decision Outcome

Chosen: **two directional slots on the agent's boundary; the spec
names the directions and what crosses them; the tool-call hook is
implementation.**

- **Inbound** is everything reaching the agent's attention: a
  delivered peer message after its attribution verifies, and a tool
  result returning from the norm bundle — bundle outputs are untrusted
  inbound content like any other, which is where tool-poisoning
  defenses live.
- **Outbound** is everything the agent does: a plain send before it
  ships, and a tool call before it compiles. The concrete tool-call
  hook (pre-invocation interposition, gateway or guardrail machinery)
  is a realization of the outbound slot, never contract surface.
- **Ordering guarantee.** An illegal committing action is refused at
  the intent, before compilation into rounds begins — refusal never
  strands an in-flight collective.
- **No per-counterparty slots.** A future counterparty type crosses
  the same boundary in one of the same two directions; the slot count
  never grows with the counterparty list.

Consequences: read-only queries are covered (they cross outbound; their
results cross inbound); the gateway/guardrail ecosystem reuse slots in
as realization of the two mounts; screening.md's placement text
generalizes from messages to boundary crossings; the slot guarantees
(fail-closed, agent-local verdicts, filters attention never the
record) apply uniformly to every crossing.
