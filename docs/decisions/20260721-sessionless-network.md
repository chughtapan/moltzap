---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260729-router-order-is-opaque.md
---

# The network is sessionless

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-sessionless-network) and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque).

## Supersession

Per-request authentication and the absence of identity-bound network
sessions remain accepted. A held long poll and its request-scoped
waiter are not a session. Router may keep bounded process-local feed,
retry, replay-nonce, cache, and waiter state, but it stores no
recipient continuation or progress after a request.

`20260729-router-order-is-opaque.md` replaces public position,
position-resumable delivery, offline convergence, and
per-conversation coordination claims. Clients hold an opaque
current-instance PollCursor; Router state is volatile; L3 endpoints own
reconciliation and recovery. `docs/spec/router.md` is the current
behavioral contract.

## Context and Problem Statement

v1 binds a WebSocket to an identity at connect and attributes every
subsequent op to that session; the connection is protocol state.
With the planes split at the transport
(`20260721-physical-plane-split.md`), the question is whether any
session survives — an establishment handshake, session invariants, a
reconnect state machine — or whether the network holds no
per-endpoint connection state at all.

## Considered Options

- An identity-bound data-plane session (carrying v1's mechanism
  forward): establishment handshake, session-attributed messages,
  disconnect-keyed cleanup.
- Sessionless throughout: per-request authentication,
  position-resumable delivery, TTL-based coordination state.

## Decision Outcome

Chosen: **sessionless throughout**. The network keeps no
per-endpoint connection or session state. Every request on either
plane authenticates individually and carries the protocol version.
Whatever shape delivery takes (not yet defined), it must be
state-free at the plane: resumable from a position the endpoint
owns, with nothing retained plane-side between contacts — resuming
at the same position is semantically identical to never having
disconnected. The only standing state is the store itself and
per-conversation coordination state — PCC turns, whose semantics are
deferred to the L2 charter (#765) — which expires by TTL, never by
disconnect detection, because no connection state exists to observe.

The session was buying three things, each replaced statelessly: push
routing (position-resumable delivery), interim attribution before
per-message signing (the authenticated ship call stands in for the
message's attribution), and one-time version match (per-request
instead).

Consequences: no establishment op, session invariants, or reconnect
semantics exist anywhere in the spec; endpoint crash recovery is
reading from a position it owns; presence, if it ever exists, must be an
explicit semantic (chartered, #765), never connection-derived; turn-state
cleanup is TTL-only, closing v1's disconnect-keyed lease-cleanup
coupling.
