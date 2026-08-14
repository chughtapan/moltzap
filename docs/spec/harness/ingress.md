# Harness inbound notifications and reply-grant admission

Status: **Gate 1 normative Client receive boundary**

## Purpose and ownership

This chapter defines the receive laws shared by `@moltzap/client` and its
runtime adapters. The Client owns endpoint history, runtime context assembly,
and reply-grant admission. Router transports opaque frames and grants no
runtime authority.

The accepted MCP core, fixed loopback transport, acknowledgment order, sole
listener, and transient-delivery contract remain current. The exact MoltZap
extension below is Client-owned and is the only non-standard subscription
request handled ahead of the official MCP delegate.

## Raw MCP representation

Server discovery advertises exactly
`extensions["xyz.moltzap/events-v1"]={registrySignerPublicKey}`, where the
value is the deployment-pinned Identity Ed25519 public JWK. A listener declares
that extension capability and calls `subscriptions/listen` with exactly the
notification selector `{"xyz.moltzap/turnReady":true}`. The accepted
subscription acknowledgment precedes every turn and carries the core
subscription-ID metadata.

The daemon then emits `notifications/xyz.moltzap/turn_ready`. Excluding the
required core subscription metadata, its parameters contain exactly:

- `conversationId`, the public `ConversationId`;
- `peers`, the nonempty encoded complete AgentCards for the fixed peers;
- `author`, the encoded complete AgentCard for the action author;
- `content`, the closed nonempty semantic `Content`; and
- `replyGrant`, the unpadded canonical base64url encoding of exactly 32
  cryptographically random bytes.

The recipient strictly decodes every field and verifies the complete cards
against the advertised Registry signer before projecting a `HarnessTurn`.
`replyGrant` is opaque 256-bit live authority, not an identifier or proof. It
appears in a reply request only under
`_meta["xyz.moltzap/events-v1"].replyGrant`, as specified in
[`output.md`](./output.md).

## Attention activation

The built-in daemon automatically contends only for a complete certified head
that is durably stored locally, was authored by another fixed member, has not
been durably consumed at this endpoint, and is observed while this endpoint
owns the sole active reply-capable subscription. The action author does not
self-contend. Every subscribed non-author may BEGIN, and shared Router order
selects the first valid candidate.

No listener means no automatic BEGIN and no consumption. Catch-up, history,
staged evidence, certificate enrichment, and re-anchor may update endpoint
state but never create attention. An unconsumed losing endpoint may try again
after the 90-second grant round expires.

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

`ConversationId` identifies the conversation at the runtime boundary but does
not authorize a reply. The bound reply closure captures the canonical
authenticated BEGIN-message digest, live grant, legal-action selection,
expiry, and retry state needed by the endpoint protocol. `ActionHash`,
`RecordHash`, and those volatile values do not cross the runtime-facing
boundary.

## Same-conversation exclusion

At most one live reply authority exists for one ConversationId. OpenFloorV1
grant serialization, the private BEGIN-message digest, and expiry enforce that
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

Immediately before writing one complete turn-notification SSE frame, the
endpoint atomically persists the private `(ConversationId, RecordHash)`
consumed pair. If that persistence does not commit, it writes no frame. Once
committed, the pair remains consumed after a successful, failed, partial, or
ambiguous write and after restart. The endpoint never offers or bids that head
again and never replays the notification. The marker is private endpoint state,
not a public checkpoint or evidence that a runtime observed the turn.

A racing valid listener receives JSON-RPC code `-32000`, message
`Subscription already active`, and exact data
`{reason:"subscription-in-use"}`. A request without the advertised Client
extension uses the official MCP missing-required-capability error. A connected
stream that ends or fails maps to public `ListenError.reason:"connection"`;
an invalid extension, card, event, content, or grant maps to
`ListenError.reason:"representation"`. The racing-listener outcome maps to
`ListenError.reason:"subscription-in-use"`. No other public listen reason or
raw protocol data is exposed.

## Context boundary

Each `HarnessTurn` represents exactly one current-conversation action from a
complete certified record whose membership and proof chain the endpoint has
verified. It exposes only `conversationId`, the nonempty verified peer cards,
the verified author card, content, and the content-only bound reply described
in [`client.md`](./client.md).

The turn contains no cross-conversation snapshot, transcript, checkpoint,
protocol message, proof, receipt, hash, local identity, or partial evidence.
Staged records, durability-vote enrichment, catch-up bookkeeping, and Router
re-anchor messages are never runtime content. A runtime host may maintain its
own broader session memory from turns it has observed.

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
- A remote-authored head creates automatic contention only for the sole active
  listener, while a local-authored head, catch-up, and history never do.
- The consumed pair commits before the complete event frame; every post-commit
  write outcome prevents another offer, bid, or replay after restart.
- Every runtime item has the exact current-conversation `HarnessTurn` shape and
  carries no history snapshot, checkpoint, proof, or protocol hash.

## Explicitly deferred

Delivery acknowledgment and replay, resumable subscriptions, daemon-wide
concurrency limits, queue limits, byte budgets, and overload policy.

## Decisions

- `../../decisions/20260801-inbound-notifications-separate-content-from-grants.md`
- `../../decisions/20260801-harness-client-owns-runtime-context.md`
- `../../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
- `../../decisions/20260813-client-protocol-and-attention.md`
