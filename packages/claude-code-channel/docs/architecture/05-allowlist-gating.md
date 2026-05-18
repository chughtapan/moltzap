# Allowlist Gating

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`gateInbound` is a caller-supplied predicate injected at boot. It is
**optional** — when absent, every inbound message passes through.

```text
Concrete code path (in entry.ts — handleInboundMessage):

  handleInboundMessage(opts, routing, serverHandle, enriched)
        │
        ├── opts.gateInbound present?
        │         │
        │   YES   │  gated = opts.gateInbound(enriched)
        │         │
        │         │  Contract (in types.ts — GateInbound):
        │         │    type GateInbound = (
        │         │      event: EnrichedInboundMessage
        │         │    ) =>
        │         │      | { _tag: "Success"; value: EnrichedInboundMessage }
        │         │      | { _tag: "Failure"; error: AllowlistError }
        │         │
        │         │  Invariants enforced by the type system:
        │         │    - Pure, synchronous (no Promise return, no I/O)
        │         │    - Must return a tagged union; no throw
        │         │    - Can MODIFY the returned EnrichedInboundMessage
        │         │      (e.g. strip metadata) by returning a new value
        │         │      inside Success — the translated notification is
        │         │      built from gated.value, not enriched directly
        │         │
        │   NO    │  gated = { _tag: "Success", value: enriched }
        │
        ├── gated._tag == "Failure"?
        │         │
        │   YES   │  logGateDropped(gated.error)   ← in entry.ts
        │         │  Effect.logInfo with AllowlistError tag
        │         │  return (no push, no routing update)
        │         │
        │   NO    │  continue to toClaudeChannelNotification(gated.value)
        │
        AllowlistError union (in errors.ts):
          SenderNotAllowed      { senderId, reason }
          ConversationNotAllowed { conversationId, reason }

Context the gate function receives — EnrichedInboundMessage fields:
  .id              message UUID (MessageId)
  .conversationId  conversation UUID (ConversationId)
  .sender.id       sender agent UUID (UserId)
  .text            message text body
  .createdAt       ISO-8601 timestamp
  (+ any other fields from @moltzap/client EnrichedInboundMessage)

The gate is evaluated BEFORE routing.recordInbound; a denied message
is never added to the LRU map, so it cannot be targeted by reply_to.
```

---

See also:
- [Inbound Message → Claude Push](02-inbound-message-to-claude-push.md)
- [Boot Sequence](01-boot-sequence.md)
