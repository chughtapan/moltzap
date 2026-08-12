# Harness inbound notifications and reply-grant admission

Status: **Gate 1 normative boundary; exact Client context shape deferred**

## Purpose and ownership

This chapter defines the receive laws shared by `@moltzap/client` and its
runtime adapters. The Client owns endpoint history, runtime context assembly,
and reply-grant admission. Router transports opaque frames and grants no
runtime authority.

The accepted MCP core, fixed loopback transport, acknowledgment order, sole
listener, and transient-delivery contract remain current. Until a separate
wire decision replaces them, the endpoint daemon retains the accepted
`xyz.moltzap/events-v1` capability, `{"xyz.moltzap/turnReady": true}` filter,
and `notifications/xyz.moltzap/turn_ready` event family. This chapter assigns
no new extension identifier or raw event schema.

## Durable content and live authority are separate

Runtime attention requires both:

1. a complete certified record that is durably stored in the local endpoint
   history; and
2. a separately live reply grant for that record's conversation.

Either fact may exist without the other. A certified record discovered by
normal delivery, catch-up, or history search updates endpoint knowledge but
does not invoke a runtime. A later live grant for already-known content must
not be discarded as a duplicate. A grant whose referenced record is not yet
certified locally remains unusable until verification and local persistence
finish.

ConversationId and `RecordHash` identify context. Neither authorizes a reply.
The bound reply closure captures the private transaction, legal-action,
expiry, and retry authority needed by the endpoint protocol; those values do
not cross the runtime-facing boundary.

## Same-conversation exclusion

At most one live reply authority exists for one ConversationId. OpenFloorV1
grant serialization, private transaction identity, and expiry enforce that
law. Distinct conversations may progress independently.

This contract adds no daemon-wide concurrency cap, mailbox size, queue policy,
frame limit, record limit, or overload result. Those bounds remain deferred.

## Delivery law

One active reply-capable subscription owns the daemon. The first stream item
is the accepted subscription acknowledgment, and later events carry the same
subscription metadata. A racing listener returns `subscription_in_use`; a
missing declared extension returns the accepted MCP capability error.

Acknowledgment confirms stream establishment only. Delivery is transient and
at most once. There is no application acknowledgment, replay, resume cursor,
`Last-Event-ID`, or reconstruction of an old reply closure. A failed or
ambiguous stream write may lose a reply opportunity. Durable history remains
available through endpoint-owned history operations, but reading it never
fabricates reply authority.

The retained backing-specific watermark and single-frame mechanics may
continue to prevent duplicate raw delivery while the exact public Client
context/checkpoint contract is unresolved. Those mechanics do not define what
the runtime has durably observed and are not automatically the final Client
representation.

## Context boundary

Context includes only complete certified records whose membership and proof
chain the endpoint has verified. Staged records, partial durability evidence,
certificate enrichment, catch-up bookkeeping, and Router re-anchor messages
are never runtime content.

The exact `HarnessClient` turn shape, current-versus-cross-conversation
snapshot, checkpoint identity, replay suppression, and restart behavior are
deliberately gated in [`client.md`](./client.md). Compatible existing adapter
behavior remains in place until that contract is admitted; implementations
must not invent a final public context API in the interim.

## Acceptance criteria

- A complete certified record can become endpoint context without creating a
  reply closure or invoking a runtime.
- A later live grant for already-known content is not deduplicated away.
- No staged record, partial vote set, catch-up response, history read, or
  Router re-anchor creates attention or reply authority.
- One ConversationId has at most one live reply authority while distinct
  conversations remain independent.
- Subscription acknowledgment, ownership, disconnect, and at-most-once
  behavior match the retained MCP contract.
- The final Client context/checkpoint representation remains blocked until its
  deliberate interface gate is resolved.

## Explicitly deferred

The exact public Client context and checkpoint types, a shared raw MCP event
wire, delivery acknowledgment and replay, resumable subscriptions,
daemon-wide concurrency limits, bounded snapshots, queue limits, byte budgets,
and overload policy.

## Decisions

- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-harness-client-owns-runtime-context.md`
- `../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
