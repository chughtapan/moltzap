---
status: superseded
date: 2026-07-24
decision-makers: Tapan Chugh
superseded-by: 20260728-endpoint-daemon-speaks-modern-mcp.md
---

# The firewall starts as MCP middleware; screening logic is deferred

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260724-firewall-starts-as-mcp-middleware).

## Supersession

This record's Gate 1 vehicle is fully superseded. The endpoint exposes
the pinned modern MCP daemon and performs deterministic action
validation inside SharedCore. Gate 1 makes no semantic L5 screening
conformance claim across MCP and does not bind official Events,
Triggers, or generic middleware as its enforcement mechanism. The
two-direction endpoint-boundary principle remains separately accepted.

## Context and Problem Statement

The firewall plan — L5's undesigned interior — needed a starting
point. Three architected proposals produced rule vocabularies, policy
engines, and screen chains; all three converged on the same floor
(most-restrictive-wins, the three-verdict lattice, the
certificate/testimony split, contacts unprivileged), but each binds a
rule-logic shape no evidence yet demands. Meanwhile the norm
hypothesis already made the outbound boundary MCP traffic (actions
are tool calls), and the MCP ecosystem ships mature middleware for
exactly that interposition point — gateways, interceptors, guardrail
proxies, tracing, audit. What does the firewall plan build first?

## Considered Options

- Record a rule vocabulary now (any of the three proposals' interiors).
- Build the interception capability first on MCP middleware patterns;
  defer all screening logic until evidence demands it.

## Decision Outcome

Chosen, **as the initial hypothesis** alongside the norm-form record:

- **The endpoint boundary is MCP.** Outbound, the agent's actions are
  tool calls (the norm servers; the channel presented to the harness
  as an MCP server — sends and conversation-start as tools). Inbound
  delivery aligns with the MCP Triggers & Events working group's
  charter (server-push callbacks with subscription lifecycle,
  delivery semantics, ordering guarantees) — chartered, early
  incubation, **tracked and not bound**: until it lands, inbound
  interception mounts on the channel's delivery path directly.
- **Build interception first.** The firewall plan's first deliverable
  is the middleware capability: standard MCP client↔middleware↔server
  interposition on both directions of the boundary, with the
  ecosystem's observability inherited (per-crossing tracing and audit
  as the default realization of context enrichment and L6 reporting).
  The two-directions contract and laws L5.1–L5.6 — fail-closed,
  agent-local verdicts, withhold-preserves-the-record,
  refuse-before-compilation — are what the mounts guarantee,
  independent of any logic plugged into them.
- **Screening logic is deferred until needed.** v0 plugs in exactly
  what already exists: the contacts-keyed stopgap
  (`endpoints/contacts.md`) and the institutional-fact check (the
  active bit; `20260724-l7-is-policy-attached-to-identity.md`). Rule
  vocabularies, fragment kinds, crossing alphabets, and policy
  engines stay undesigned; the three proposal drafts
  (`v2/drafts/firewall-plan-proposals/`) are recorded inputs for when
  evidence demands logic, their triple convergences (most-restrictive
  as the only combinator; admit / admit-under-limits /
  withhold-preserving-record; deterministic checks as certificates,
  model judgment as testimony; contacts and any future source
  unprivileged) noted as the likely floor — noted, not bound.

Consequences: the harness adapter question (channels.md Q1) gains a
reference direction — the adapter is an MCP client connection —
without being bound; middleware, tracing, and audit machinery is
reused rather than built; nothing interpretive is added to the
router; and the firewall plan stops being a blocking design item —
the mounts are buildable now, and the logic arrives increment by
increment behind them.
