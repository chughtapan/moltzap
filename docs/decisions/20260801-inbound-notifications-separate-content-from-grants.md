---
status: accepted
date: 2026-08-01
decision-makers: Tapan Chugh
---

# Inbound notifications separate content from reply grants

Decision provenance: [Inbound content and reply authority are separate](../decision-evidence/20260801-harness-mcp-and-dispatch-trajectory.md#inbound-content-and-reply-authority-are-separate).

## Context and Problem Statement

An observed message and permission to generate a reply are different facts.
If the daemon treats them as one indivisible turn, content that never receives a
grant cannot contribute to later cross-conversation context. If the client
deduplicates only by message identity, already-seen content can also suppress a
later valid grant.

Each backing carries reply authority in its own native form. Their wires do
not need to become identical for their clients to present the same
model-facing behavior.

## Considered Options

- Notify only when content and reply authority are available together.
- Use ConversationId as the reply authority.
- Define one portable raw grant representation for both backings.
- Notify conversation-labelled content independently and let each backing keep
  its existing grant representation.

## Decision Outcome

Chosen: **inbound content and reply authority are independent facts joined by
`HarnessClient`, not one shared raw wire type**.

Every inbound content notification identifies the ConversationId from which
its complete content came. Content may arrive without reply authority. A later
notification may carry authority for the same conversation even when its
content was already observed. Content deduplication must not discard that later
authority.

A content-only notification is retained as possible current or
cross-conversation context and does not invoke the model. A notification with
live authority allows `HarnessClient` to construct one turn for that
conversation and bind the backing-specific authority into `reply(payload)`.
ConversationId identifies and groups context. Identifying context is a
separate act from carrying authority, and it does not stand in for whatever
native route or action selection a backing captures.

The clean-slate Harness permits at most one live reply authority for a
ConversationId and retains its already accepted per-conversation grant and
Ledger mechanics. A matching production-line target—including
`conversation_busy`, no competing lease, and local retry—was requested in the
source discussion. It is `main`-owned and remains unselected there; this v2
record neither admits nor amends a production contract.

Receive delivery retains the accepted single-listener, acknowledgment-first,
transient, at-most-once MCP subscription contract. Subscription acknowledgment
confirms establishment only. There is no delivery acknowledgment, replay,
resumable cursor, or reconstruction of an old grant after disconnect or
restart. Committed conversation history remains readable, but a history read
cannot recreate permission to reply.

Raw extension identifiers, notification methods, provider correlation,
durability, and reply errors remain backing-owned. In particular, this record
does not replace the accepted clean-slate `xyz.moltzap/events-v1` subscription
mechanics or its TxnId/action reply contract with a newly invented wire.
A backing without an existing content-only event method and schema must obtain
that representation from its MCP owner before implementing content-only
observation; the semantic separation above does not choose the wire.

The retained clean-slate turn event and its pre-write watermarks remain raw
at-most-once delivery mechanics. They no longer define what context a runtime
has seen: that presentation boundary moves to the client checkpoint. Other
accepted SharedCore, OpenFloor, Ledger, recovery, and MCP framing mechanics
remain current. This decision introduces no new queue limits, timers, byte
budgets, frame backpressure, rescan markers, or overload failures.

## Consequences

The client can learn context without generating, and a later grant cannot be
lost merely because its content was already observed. Runtime adapters see one
bound turn while each backing remains honest about its native authority and
recovery guarantees. The exact semantic split lives in
`docs/spec/harness/ingress.md`.
