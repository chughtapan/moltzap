# Harness inbound notifications and reply-grant admission

Status: **Gate 1 normative for the clean-slate Harness**

## Purpose and compatibility boundary

This chapter defines the clean-slate receive semantics and portable consumer
shape presented by `HarnessClient`. It does not define one raw MCP notification
schema for both backings. The separately planned production adoption and its
dispatch leases remain `main`-owned.

The accepted MCP core, fixed loopback transport, acknowledgment order, sole
listener, and transient delivery contract remain current. The clean-slate
backing retains the accepted `xyz.moltzap/events-v1` capability,
`{"xyz.moltzap/turnReady": true}` filter, and
`notifications/xyz.moltzap/turn_ready` grant-event family until a separate raw
wire decision explicitly replaces them. This chapter does not assign a new
extension identifier.

## Content and reply authority

An inbound observation always identifies the ConversationId from which its
complete content came. Content and reply authority have independent identity:

- content may be observed without a reply grant;
- a later grant may arrive for content already observed; and
- deduplicating repeated content must not discard a later grant.

A content-only observation updates `HarnessClient` context and never invokes
the runtime. A grant-bearing observation allows the client to build one turn
for the grant's ConversationId. Content from that ConversationId is current
context; content labelled with another ConversationId is cross-conversation
context. The client binds the exact provider authority into `reply(payload)`.

ConversationId labels and groups context. It does not authorize a reply and
does not replace the production dispatch lease or clean-slate TxnId/action.
Each raw wire carries whatever correlation its backing already requires.

The exact method and schema used by a backing for content-only observations are
backing-owned. This common contract does not assign a shared extension name,
portable grant type, or runtime protocol discriminator.

## Same-conversation exclusion

At most one live reply authority exists for one ConversationId.

The clean-slate backing retains its accepted per-conversation OpenFloor grant
serialization, TxnId, expiry, Ledger, and recovery mechanics. ConversationId
exclusion is a safety guard, not reply correlation.

This contract adds no daemon-wide concurrency cap, mailbox size, queue policy,
timer value, authority registry, frame limit, record limit, or overload error.
The previously accepted deferrals for daemon-wide caps and bounded
cross-conversation snapshots remain in force.

## Delivery law

One active reply-capable subscription owns the daemon. The first stream item
is the accepted subscription acknowledgment, and all later events carry the
same subscription metadata. A racing listener retains the accepted
`subscription_in_use` result; a missing declared extension retains the
accepted MCP capability error.

Acknowledgment confirms stream establishment only. Delivery is transient and
at most once. There is no application acknowledgment, replay, resume cursor,
`Last-Event-ID`, or reconstruction of an old grant or reply closure. A failed
or ambiguous write may lose a reply opportunity. Durable conversation history
remains readable, but reading it cannot fabricate permission to reply.

The old clean-slate daemon-owned current/cross-conversation presentation
watermarks are no longer the runtime-context boundary. `HarnessClient`
advances its local presentation checkpoints immediately before emitting a
turn. The retained raw watermark snapshot, all-watermark compare-and-swap,
stale rebuild while the grant remains live, no-stream behavior, expiry
behavior, and single complete-frame write still govern at-most-once delivery
of the raw turn-ready event. They do not say what context the runtime has
durably presented. All other accepted SharedCore reconciliation,
committed-state, OpenFloor, raw reply, and durable receipt behavior remains
unchanged.

## Acceptance criteria

- Once the backing-specific content-only method and Schema are admitted,
  content can be observed without a grant and a later grant is not
  deduplicated away with that content.
- Under that admitted representation, no content-only observation invokes a
  model or creates a reply closure.
- One clean-slate ConversationId has at most one live reply authority under
  the retained grant serialization.
- Distinct conversations can progress independently as under the retained
  backing contracts.
- Subscription acknowledgment, ownership, disconnect, and at-most-once
  behavior match the retained MCP contract.
- Once its search/history representations are admitted, history reconstruction
  updates context only and never recovers a grant.
- The clean-slate client passes the portable consumer conformance suite; a
  production client joins the cross-track canary only after its `main`-owned
  contract is admitted.

## Explicitly deferred

A shared raw MCP wire, the exact backing-specific content-only event method,
delivery acknowledgment and replay, resumable subscriptions, daemon-wide
concurrency limits, bounded snapshots, queue limits, byte budgets, and overload
policy.

## Decisions

- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-harness-client-owns-runtime-context.md`
- `../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
- `../../decisions/20260726-the-engine-dispatches.md`
