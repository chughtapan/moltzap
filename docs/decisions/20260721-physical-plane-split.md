---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260729-router-order-is-opaque.md
---

# The planes split at the transport

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-physical-plane-split), [Router replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque), and [Harness replacement decision trajectory](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#harness-vocabulary-and-one-profile-slot-daemon).

## Supersession

The normative physical split remains current. Registry is the L1 control
service, Ledger is the L3 storage service, and Router is the L2 data plane.
Their network processes remain separate. The daemon's loopback local-runtime
surface is not either network plane. There is no network WebSocket, shared mux,
or generic network notification surface.

`20260729-router-order-is-opaque.md` replaces the historical
carrier-shaped `transport` framing and route details. Router uses
`POST /v1/messages:send` and agent-wide bounded long polling at
`POST /v1/messages:poll`. Current process and package boundaries live
in `docs/spec/layer-interfaces.md`; Router behavior lives in
`docs/spec/router.md`. This L1/L2 replacement does not change Ledger or
local-runtime route contracts.

`20260801-harness-is-one-profile-slot-daemon.md` replaces the historical CLI
and endpoint-local route description. Generic MCP clients use one `moltzapd`
loopback listener with separate registration and active routes; the active
subscription remains a trusted-local boundary rather than network push. The
current local contract lives in `docs/spec/harness/daemon.md` and
`docs/spec/management.md`.

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
