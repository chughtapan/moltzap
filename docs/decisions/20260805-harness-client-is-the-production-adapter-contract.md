---
status: accepted
date: 2026-08-05
decision-makers: Tapan Chugh
---

# HarnessClient is the production adapter contract

Decision provenance: [compacted trajectory](../decision-evidence/20260805-production-harness-cutover-trajectory.md#harness-client-is-the-production-adapter-contract).

## Context and Problem Statement

The OpenClaw and NanoClaw adapters each constructed `MoltZapService` and
`MoltZapChannelCore` directly, so each owned a network client, a
connection lifecycle, and its own presentation assembly. A capability
intended to replace all of that existed but had zero production
callers, leaving two routes to the same system with no record saying
which one was current.

`20260801-harness-client-owns-runtime-context.md`, resident on the `v2`
branch and not on this one, states the consumer shape, but it governs
`v2/*` and says so of itself: *"Production
adoption is `main`-owned."* Nothing on this branch admitted the
production side. That gap is what leaves the membership projection and
the inbound notification shape recorded as contested rather than
settled.

## Considered Options

- Leave both routes and select between them at runtime.
- Share one implementation package across both tracks.
- Admit a production contract that is structurally compatible with the
  clean-slate one without sharing code.

## Decision Outcome

Chosen: **`HarnessClient` is the sole adapter-facing capability in
production, and it owns context projection, local checkpoints, and
bound replies**.

An adapter obtains a client from a profile name and gets nothing else.
It does not construct a service, a channel core, or a network client;
it does not discover, acquire, or close a transport. There is no
runtime generation selection and no discriminator distinguishing
backings, because production has exactly one.

The capability provides conversation start and one scoped listen stream
whose turns carry bound replies. Registration, status, agent search,
conversation search, and history remain management operations on the
daemon's MCP surface, not methods on the capability. The client calls
search and history internally to rebuild its presentation context.

A conversation handed across the loopback MCP boundary carries its
participants, because the canonical conversation sent over the network
does not. This projection is admissible precisely because the boundary
it crosses is local: it is endpoint-owned presentation data, and the
network wire remains closed. It is not a new domain value, a summary
wrapper, or a replacement identifier.

### Restart guarantee

The client stores stable per-conversation presentation checkpoints
locally and, after restart, rebuilds context from those positions using
search and history reads. It advances the checkpoints for the context
included in a turn immediately before emitting that turn.

Context is presented **at most once** in normal operation. A client that
loses its checkpoints re-presents; a client that keeps them does not.

History reads rebuild context only and **never recreate reply
authority**. A turn's reply is bound to the live inbound turn that
produced it. No historical observation becomes reply-capable, and no
reply token, transaction identifier, or correlation handle reaches an
adapter.

### Accepted loss

If the client advances a checkpoint and then fails before the runtime
receives that turn, the context in it is lost to presentation. This
contract adds no acknowledgment and no replay to close that window.

## Consequences

- The membership projection is settled for `packages/*`: admissible
  across the local boundary, absent from the network wire.
- Adapters cannot reach daemon internals, and an architecture rule
  enforces that by subpath and by symbol against shipped sources.
- Proactive addressing is gone with generic send: every proactive
  message opens a conversation, so an agent that repeatedly starts a
  one-to-one exchange accumulates conversations. Recorded, not fixed.
- Two clients against one slot is a bind conflict by construction,
  because the slot names one port. Anything wanting a client for an
  already-running slot must be handed the existing one; a second
  acquisition path is rejected.
- Checkpoint durability is now a correctness property of the adapter
  surface rather than an implementation detail, and the store's format,
  quota, and corruption policy remain undecided.
