---
status: accepted
date: 2026-07-21
decision-makers: Tapan Chugh
---

# The network is sessionless

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
  forward): establishment handshake, session-attributed frames,
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
per-frame signing (the authenticated ship call stands in for the
frame's attribution), and one-time version match (per-request
instead).

Consequences: no establishment op, session invariants, or reconnect
semantics exist anywhere in the spec; endpoint crash recovery is
reading from a position it owns; presence, if it ever exists, must be an
explicit semantic (chartered, #765), never connection-derived; turn-state
cleanup is TTL-only, closing v1's disconnect-keyed lease-cleanup
coupling.
