---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260728-network-wire-is-http-post-polling.md
---

# The planes split at the transport

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-physical-plane-split).

## Supersession

The core Decision Outcome — a normative physical split between control
and data planes — remains current. Later accepted records supersede the
body phrases about v1 WebSocket muxing, a data-plane shape “not yet
defined,” disconnect, and socket replay; those phrases are historical
context, not the Gate 1 contract.

Gate 1 binds Registry and Ledger operations to their closed,
individually authenticated HTTP POST routes. Router traffic uses
`POST /v1/messages:send` and endpoint-wide bounded long polling at
`POST /v1/deliveries:poll`. The separate local runtime boundary is
loopback MCP `POST /mcp`, including request-scoped
`subscriptions/listen`; it is neither network plane. There is no
network WebSocket, shared mux, or generic notification surface.

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
