---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Router order is opaque

Decision provenance: [compacted trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque).

## Context and Problem Statement

L2 must provide one non-equivocating global order without turning that
order into a public storage protocol. Exposing RouterSequence made a
private in-memory implementation position part of every consumer
contract. Durable cursors, per-recipient queues, or recipient progress
would instead make the Router a stateful delivery service and pull L3
replay and recovery semantics into the data plane. The package name
`transport` also described a carrier-shaped abstraction while the
package actually owns the Router data plane.

## Considered Options

- Expose RouterSequence values in accepted results and delivered
  records.
- Return an opaque authenticated client-held PollCursor while the
  Router keeps order private.
- Return only RouterInstanceId from a successful send and rely on
  self-delivery, or also return the Router-owned SignedMessageDigest as
  a live byte-equality receipt.
- Persist Router feeds or cursors, or maintain per-recipient message
  copies, queues, acknowledgements, or progress.
- Keep one count-and-byte-bounded volatile global feed containing one
  copy of each accepted SignedMessage.
- Keep the control-plane-shaped `transport` package name.
- Name the data-plane package `router`.
- Require application TLS termination.
- Leave transport security to deployment.

## Decision Outcome

Chosen: **Router order is private, continuation is opaque and
client-held, and the L2 package is `router`**.

### Binding outcome

One correct non-equivocating Router process assigns a private `bigint`
order to each accepted SignedMessage. The value never appears in a
public request, result, exported type, or protocol log field. The
Router returns ordering progress only through an opaque `PollCursor`
bound to the authenticated AgentId and current RouterInstanceId.
`docs/spec/router-representation.md` owns its exact Compact JWE
representation and rejection rules.

An accepted send returns RouterInstanceId and the Router-owned
SignedMessageDigest of the complete SignedMessage JWS. The digest
confirms equality with one current retained entry under the
correct-Router assumption. It is not an ordering position, delivery
proof, durable retry identity, or substitute for self-delivery. The
instance-only result was considered and not chosen.

The Router keeps one count-and-byte-bounded volatile global feed with
one copy of each accepted SignedMessage and one coupled retry index.
It stores no durable feed, cursor, recipient copy, recipient queue,
session, conversation, transaction, acknowledgement, or
recipient-specific advancement. Request-scoped long-poll waiters do
not survive their requests.

An omitted cursor returns an immediate empty batch anchored at the
current tail. Continuations scan the global feed in order, filter by
recipient, advance past unrelated messages, and do not skip an
addressed message at a batch boundary. A cursor behind global eviction
returns conservative `feed_gap`. Malformed, tampered, wrong-caller,
wrong-instance, future-order, noncanonical, or old-key cursors return
`cursor_invalid`.

Every send names the expected RouterInstanceId and declares `initial`
or `retry`. Initial duplicate identity conflicts. An identical
retained retry returns its original accepted result, a changed retry
conflicts, and an evicted or unknown retry returns
`retry_identity_unknown`. Restart creates a fresh instance and cursor
key and loses all feed, retry, nonce, cache, and waiter state.

The package and npm project are `router` and `@moltzap/v2-router`.
`router` depends on `identity`; Registry remains the L1 control service,
Router the L2 data plane, and Ledger a sibling storage service. The
Registry binary is `moltzap-registry`; the Router binary remains
`moltzap-router`.

The Router application has no TLS, certificate, scheme, or
trusted-proxy configuration. Deployment preserves the signed HTTP
fields at ingress and protects unsigned Router responses when traffic
crosses a network path inside its threat model. Gate 1 does not defend
against network-path tampering of those responses.

### Guarantee

Under the Gate 1 assumption of one correct non-equivocating Router,
recipients observe identical retained SignedMessage bytes in one
global order. Availability, retention loss, or restart can stop
progress and require L3 reconciliation, but does not create a second
order. L2 claims no durable replay, offline convergence, or
restart-transparent liveness.

### Mechanism

A private counter, bounded ring, coupled O(1) retry index, authenticated
Compact JWE cursor, bounded positive AgentCard cache, and
request-scoped waiters realize the guarantee. They remain private
mechanisms rather than public routing concepts.

### Deliberate deferrals

Router persistence, replication, failover, Byzantine sequencing, fork
detection, stable instance identity, per-recipient indexes, network
push, and end-to-end body encryption remain future work. Conversations,
reliability, transactions, replay, and recovery remain L3 endpoint
responsibilities.

## Consequences

Consumers cannot treat the Router's internal position as durable
evidence or storage identity. They retain only the opaque PollCursor
for the current process instance and recover gaps or restart through
L3. The Router stays lightweight and carries no server-side recipient
progress. Renaming `transport` to `router` makes the package vocabulary
match its data-plane authority without adding a seventh package.
