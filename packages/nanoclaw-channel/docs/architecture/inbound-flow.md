# Inbound Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Inbound messages arrive from `MoltZapChannelCore` as
`EnrichedInboundMessage` objects (enriched by `@moltzap/client` with
conversation metadata and context blocks). The channel's callback,
registered in the constructor via `core.onInbound`, runs the full
inbound pipeline synchronously.

```mermaid
sequenceDiagram
    participant Core as MoltZapChannelCore (@moltzap/client)
    participant Handler as handleInbound (channels/moltzap.ts)
    participant Router as nanoclaw router

    Core->>Handler: WS frame arrives— core decodes + enriches<br>fires onInbound callback with EnrichedInboundMessage:<br>{ id, conversationId, sender, text, createdAt,<br>  dispatchLeaseId?, replyToId?,<br>  conversationMeta?: { type, name, participants },<br>  contextBlocks: { crossConversationMessages?, groupMetadata? },<br>  isFromMe }
    Note over Handler: Effect.sync(() => this.handleInbound(msg))

    Note over Handler: Step 1 — jidFromConversationId(enriched.conversationId)<br>chatJid = "mz:" + conversationId (§3.5)

    Note over Handler: Step 2 — rememberDispatchLease(chatJid, enriched)<br>if enriched.dispatchLeaseId:<br>  leaseStore.remember(chatJid, leaseId)

    Note over Handler: LeaseStore<string, string> (peek-style)<br>keyed by chatJid (not conversationId)<br>value = LAST inbound lease for that jid<br>NOT cleared on send (server enforces single-use — deliberate stale-entry-on-retry)

    Note over Handler: Step 3 — maybeAutoRegister(chatJid, conversationId)<br>evalMode=false → skip<br>evalMode=true  → ensureAutoRegistered() (§3.6)

    Handler->>Router: Step 4 — opts.onChatMetadata({<br>  chatJid, timestamp: enriched.createdAt,<br>  name: enriched.conversationMeta?.name,<br>  channel: "moltzap",<br>  isGroup: conversationMeta?.type === "group"<br>})<br>nanoclaw router receives ChatMetadata BEFORE message<br>(test: "emitsMetadataBeforeMessage")

    Handler->>Router: Step 5 — opts.onMessage(chatJid, toNewMessage(chatJid, enriched))<br>→ NewMessage projection (§3.7)
```

---

Previous: [connect / disconnect Lifecycle](./connect-disconnect-lifecycle.md)
Next: [Outbound sendMessage Flow](./outbound-send-message.md)
