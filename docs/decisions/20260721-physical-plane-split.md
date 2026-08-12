---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# The planes split at the transport

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-physical-plane-split), [Router replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque), and [Harness replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon).

## Supersession

Registry remains the independent control-plane network service and Router the
independent data-plane network service. The daemon's loopback MCP surface
remains a trusted local runtime boundary rather than a network plane. No
network WebSocket, shared multiplexer, or generic network notification surface
is introduced. The current Registry and Router routes remain owned by their
wire ADRs and specifications.

`20260811-four-layer-endpoint-replicated-harness.md` removes Ledger as a third
network process and replaces Ledger transcript recovery with endpoint-local
replication, certified-head catch-up, and Router-instance re-anchoring. It also
replaces profile-slot and split local MCP paths with explicit daemon state and
one state-dependent `/mcp` surface. The replacement record,
`docs/spec/control-plane.md`, `docs/spec/router.md`,
`docs/spec/harness/daemon.md`, and `docs/spec/management.md` own the current
topology.

## Context and Problem Statement

The constitution separates control plane and data plane, but the wire
binding was undecided: v1 muxes everything — request/response ops,
notifications, and reverse callbacks — over one WebSocket. With the
app layer gone, the question is whether v2 keeps one shared transport
or gives each plane its own.

## Considered Options

- Guarantee-level spec only; one muxed transport as the v0
  realization.
- One shared transport carrying both planes, normative.
- Physical split, normative: each plane binds to its own surface.

## Decision Outcome

Chosen: **physical split, normative**. The control plane is
request/response over HTTP: administrative ops only, nothing pushed.
The data plane rides its own surface — message shipping and delivery,
concrete shape not yet defined — and carries only data-plane
traffic, with L1 messages as byte-preserved payloads. Neither surface
carries the other's ops.

Consequences: the CLI is a plain HTTP client, not a privileged
principal; content-blindness and plane separation become wire facts
rather than API discipline; v1's two-engine socket mux has no
successor; recovery after disconnect rides transcript reads, never
socket replay. How callers authenticate on each surface is the
sessionless decision (`20260721-sessionless-network.md`).

## Record changelog

Point corrections that leave the historical Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-11 | Recorded the four-layer replacement and the exact scope this record still retains. The historical Decision Outcome is untouched; the visible Supersession section owns current applicability. |
