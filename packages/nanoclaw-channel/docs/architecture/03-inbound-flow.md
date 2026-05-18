# Inbound Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Inbound messages arrive from `MoltZapChannelCore` as
`EnrichedInboundMessage` objects (enriched by `@moltzap/client` with
conversation metadata and context blocks). The channel's callback,
registered in the constructor via `core.onInbound`, runs the full
inbound pipeline synchronously.

```
  MoltZapChannelCore (@moltzap/client)
       │
       │ WS frame arrives; core decodes + enriches message
       │ fires onInbound callback with EnrichedInboundMessage:
       │   { id, conversationId, sender, text, createdAt,
       │     dispatchLeaseId?, replyToId?,
       │     conversationMeta?: { type, name, participants },
       │     contextBlocks: { crossConversationMessages?, groupMetadata? },
       │     isFromMe }
       │
       │ channels/moltzap.ts → onInbound handler (wired via core.onInbound)
       ▼
  Effect.sync(() => this.handleInbound(msg))
  └── handleInbound(enriched)               channels/moltzap.ts → handleInbound

         │
         ├─1─▶ chatJid = jidFromConversationId(enriched.conversationId)
         │        "mz:" + conversationId            (§3.5)
         │
         ├─2─▶ rememberDispatchLease(chatJid, enriched)
         │        channels/moltzap.ts → rememberDispatchLease
         │        if enriched.dispatchLeaseId:
         │          dispatchLeasesByJid.set(chatJid, leaseId)
         │        ┌────────────────────────────────────────────┐
         │        │  dispatchLeasesByJid : Map<jid, leaseId>   │
         │        │  keyed by chatJid (not conversationId)     │
         │        │  value = LAST inbound lease for that jid   │
         │        │  NOT cleared on send (post-cutover #533)   │
         │        └────────────────────────────────────────────┘
         │
         ├─3─▶ maybeAutoRegister(chatJid, conversationId)
         │        channels/moltzap.ts → maybeAutoRegister
         │        evalMode=false → skip
         │        evalMode=true  → ensureAutoRegistered()  (§3.6)
         │
         ├─4─▶ emitChatMetadata(chatJid, enriched)
         │        channels/moltzap.ts → emitChatMetadata
         │        opts.onChatMetadata({
         │          chatJid, timestamp: enriched.createdAt,
         │          name: enriched.conversationMeta?.name,
         │          channel: "moltzap",
         │          isGroup: conversationMeta?.type === "group"
         │        })
         │        ← nanoclaw router receives ChatMetadata BEFORE message
         │          (test: "emitsMetadataBeforeMessage")
         │
         └─5─▶ opts.onMessage(chatJid, toNewMessage(chatJid, enriched))
                  channels/moltzap.ts → toNewMessage call
                  → NewMessage projection  (§3.7)
```

---

Previous: [02 — connect / disconnect Lifecycle](./02-connect-disconnect-lifecycle.md)
Next: [04 — Outbound sendMessage Flow](./04-outbound-send-message.md)
