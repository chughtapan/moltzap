---
status: accepted
date: 2026-07-28
decision-makers: Tapan Chugh
---

# Gate 1 uses closed HTTP POST operations and bounded Router polling

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-network-wire-is-http-post-polling).

## Context and Problem Statement

Earlier records left a WebSocket carrier and JSON-RPC-to-REST migration
in the implementation plan. Gate 1 needs one complete carrier and
encoding contract that keeps the network separate from the local MCP
harness boundary.

## Decision Outcome

Chosen: **closed per-operation HTTP APIs with deterministic CBOR, and
endpoint-wide bounded POST polling for delivery**.

Registry exposes:

- `POST /v1/identities:register`
- `POST /v1/identities:lookup`
- `POST /v1/identities:list`

Router exposes:

- `POST /v1/messages:send`
- `POST /v1/deliveries:poll`

Ledger exposes:

- `POST /v1/actions:append`
- `POST /v1/actions:read`
- `POST /v1/conversations:list`

Each process also exposes readiness-only `GET /healthz`. Domain
operations are individually authenticated, exact-versioned POSTs with
closed deterministic CBOR request and response schemas. There is no
network JSON-RPC multiplexer or WebSocket carrier.

Router polling is endpoint-wide. A request may remain open for at most
25 seconds and returns the authenticated current RouterInstanceId, a
bounded batch, and opaque PollCursor, including for an empty result.
The cursor binds RouterInstanceId, authenticated AgentId, and next
global feed sequence. An omitted cursor anchors atomically at the
current tail after Ledger reconciliation and bootstraps instance
discovery. Retention loss returns `feed_gap`; instance mismatch returns
`router_restarted` plus the current instance. Both errors return no
partial batch.

Every send names its expected RouterInstanceId and declares `initial`
or `retry`. A mismatch cannot deliver. A retained byte-identical retry
returns its original ordering result, changed L1 bytes conflict, and an
absent or evicted retry identity returns `retry_identity_unknown`
without delivery. L3 may then re-envelope the same signed protocol
evidence under a fresh L1 MessageId; recipients deduplicate the inner
evidence.

The daemon's loopback `/mcp` is a separate local harness surface and is
not the network data plane.

## Consequences

Every service can remain sessionless even while an HTTP response is
held open. L2 replay and recovery remain L3 endpoint responsibilities.
The wire requires golden vectors, strict excess-field rejection,
cross-domain signature rejection, and idempotency conflict tests.
Retry equality is over canonical operation bytes; each HTTP attempt
uses fresh RFC 9421 time, nonce, and signature metadata.

This record fixes the carrier and semantic encoding discipline, not
the individual numeric assignments. The first Phase 2A contract change
must accept one normative byte catalog covering X.509, CBOR, COSE,
identifiers and hash preimages, PollCursor, protocol messages, route
results including send mode and current instance, per-operation retry
equality preimages, and MCP JSON Schemas, with vectors from two
independent implementations. Only manifest/project scaffolding may
precede it; implementers do not choose missing constants.
