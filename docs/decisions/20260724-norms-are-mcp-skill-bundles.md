---
status: superseded
date: 2026-07-24
decision-makers: Tapan Chugh
superseded-by: 20260728-open-floor-v1.md
---

# Norms are MCP-served skill bundles (initial hypothesis)

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260724-norms-are-mcp-skill-bundles).

## Supersession

This hypothesis is fully superseded as current design authority. It
remains historical input to the deferred post-Gate-1 norm-bundle
question. Gate 1 embeds OpenFloorV1, advertises legal-action descriptors
through one turn-ready event, and exposes `reply` rather than one model
tool per norm action. Deterministic executable NormPin identity remains
unresolved.

## Context and Problem Statement

tasks.md fixed norms as versioned skill bundles pinned per binding but
left the bundle's form and the same-version mechanism open. The L4
research found a mature vehicle: the skills-over-MCP working group's
extension serves skills as digest-pinned, content-bound resources;
the skills-as-groups convention declares each skill's primitive
dependencies as metadata; the protocol's stateless rewrite makes a
per-request projection idiomatic; and the ecosystem's own normative
language states that tool visibility is never an access-control
mechanism. What form does a norm bundle take, and how do legal moves
reach and bind an agent?

## Considered Options

- A bespoke moltzap bundle format.
- The norm as an MCP-served skills bundle: tools are actions,
  committing actions compile to ledger transactions.
- Wait for upstream standardization to converge before binding.

## Decision Outcome

Chosen, **as the initial hypothesis** — revisited on implementation
evidence and on movement in the upstream vehicle:

- **A norm is a digest-pinned skills bundle served over MCP.** Skills
  carry the norm's prose, schemas, and rules; the bundle's tools are
  the norm's actions, declared per skill as metadata; read-only tools
  are projection queries, committing tools compile to one or more
  collective transactions on the ledger
  (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
- **Legal moves are a pure function of committed ledger state**,
  computed endpoint-side per request. The projection informs; it
  never enforces.
- **Interim enforcement posture: hooks, not prompts.** v0 computes
  the legal-move set and enforces it with endpoint hooks at the L5
  slots — an illegal move is refused at invocation. Reshaping the
  model-visible tool surface (skill activation, deferred tools,
  progressive disclosure) is not required: affordance is never the
  enforcement boundary — a host may ignore it — so prompt-shaping is
  an optimization, adopted later if wanted, never load-bearing.
- **Same-version agreement is digest citation.** The bundle pin is
  content-bound — a digest over the bundle's files — and a binding's
  participants agree by citing the same digest; any file drift breaks
  the pin. Where the citation rides (conversation start, a standing
  relationship) stays open.
- **Placement is endpoint-local by existing law.** Tasks have no
  network representation (clause 2); each participant runs its own
  copy of the pinned bundle, and the router never sees a norm.

Vehicle, named for the interim as the signature profile named RFC
9421: MCP with the skills extension (SEP-2640, in review) and the
skills-as-groups metadata convention; the transport is not
stdio-bound — the norm's behavior is a stateless projection, carried
however. The upstream discovery space is deliberately unsettled,
which is why this record is a hypothesis, not design law.

Still open: multi-norm composition in one conversation; the
correlation/idempotency convention for the compile step (candidate:
signed attestation envelopes in request metadata); what "pinned per
binding" binds to; the task-type vocabulary; the affordance layer's
eventual shape.

Consequences: the deferred contract layer — "here are your legal next
moves" — gains its computational form (a projection over the ledger
fold) without new network surface; L5 action-screening gains a
concrete interposition point (tool invocation), whose mount placement
is deliberately not decided here; tasks.md's bundle-format question
narrows to bundle *contents* at guarantee level.
