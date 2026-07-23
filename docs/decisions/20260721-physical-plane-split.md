---
status: accepted
date: 2026-07-21
decision-makers: Tapan Chugh
---

# The planes split at the transport

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
The data plane rides its own surface — frame shipping and delivery,
concrete shape not yet defined — and carries only data-plane
traffic, with L1 frames as byte-preserved payloads. Neither surface
carries the other's ops.

Consequences: the CLI is a plain HTTP client, not a privileged
principal; content-blindness and plane separation become wire facts
rather than API discipline; v1's two-engine socket mux has no
successor; recovery after disconnect rides transcript reads, never
socket replay. How callers authenticate on each surface is the
sessionless decision (`20260721-sessionless-network.md`).
