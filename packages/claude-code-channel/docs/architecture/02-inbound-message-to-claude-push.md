# Inbound Message → Claude Push

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

When the WS connection delivers a message, `MoltZapChannelCore` calls every
registered `onInbound` callback. The channel registered one at boot step 7.

```text
MoltZap server     @moltzap/client         entry.ts                event.ts       server.ts
     |                    |                    |                       |               |
     | WS frame           |                    |                       |               |
     |..........> MoltZapChannelCore           |                       |               |
     |                    | onInbound(enriched)|                       |               |
     |                    |------------------->|                       |               |
     |                    |               handleInboundMessage         |               |
     |                    |               (in entry.ts)               |               |
     |                    |                    |                       |               |
     |                    |               [A] opts.gateInbound?        |               |
     |                    |                    |                       |               |
     |                    |               YES: gateInbound(enriched)  |               |
     |                    |               (pure, sync — in types.ts)  |               |
     |                    |                    |                       |               |
     |                    |               { _tag:"Failure" }          |               |
     |                    |               logGateDropped              |               |
     |                    |               (in entry.ts) + return      |               |
     |                    |               AllowlistError surfaced      |               |
     |                    |               as log only, not propagated  |               |
     |                    |                    |                       |               |
     |                    |               NO gate / { _tag:"Success" }|               |
     |                    |                    |                       |               |
     |                    |               [B] toClaudeChannelNotification(gated.value)|
     |                    |                    |---------------------->|               |
     |                    |                    |                       |               |
     |                    |                    |        [B1] content check (in event.ts)
     |                    |                    |        event.text empty              |
     |                    |                    |        --> { _tag:"Err", ContentEmpty }
     |                    |                    |        logTranslationFailed + return |
     |                    |                    |                       |               |
     |                    |                    |        [B2] decodeNotificationMeta   |
     |                    |                    |        (in event.ts)                |
     |                    |                    |        chat_id  = conversationId     |
     |                    |                    |        message_id = id               |
     |                    |                    |        user     = sender.id          |
     |                    |                    |        ts       = createdAt (ISO)    |
     |                    |                    |                       |               |
     |                    |                    |        any brand fails:              |
     |                    |                    |        MetaInvalid / ContentEmpty    |
     |                    |                    |        logTranslationFailed + return |
     |                    |                    |<----------------------|               |
     |                    |                    |                       |               |
     |                    |               [C] routing.recordInbound(message_id, chat_id)
     |                    |               (in routing.ts) — advances lastActive,     |
     |                    |               inserts into LRU map (cap 256)             |
     |                    |                    |                       |               |
     |                    |               [D] serverHandle.push(notification)        |
     |                    |               (in entry.ts)               |               |
     |                    |                    |-------------------------------------->|
     |                    |                    |                       |               |
     |                    |                    |                       | state.initialized?
     |                    |                    |                       |               |
     |                    |                    |                       |  NO (pre-handshake):
     |                    |                    |                       |  state.pending.push()
     |                    |                    |                       |  (in server.ts)
     |                    |                    |                       |  flushed later
     |                    |                    |                       |  at oninitialized
     |                    |                    |                       |               |
     |                    |                    |                       |  YES:          |
     |                    |                    |                       |  server.notification({
     |                    |                    |                       |   method: "notifications/claude/channel",
     |                    |                    |                       |   params: { content, meta }
     |                    |                    |                       |  })           |
     |                    |                    |                       |  (in server.ts)
     |                    |                    |                       |               |
     |                    |                    |                       |    EmitFailed  |
     |                    |                    |                       |    logWarning, |
     |                    |                    |                       |    swallowed   |
     |                    |                    |                       |    (in entry.ts)
     |                    |                    |                       |               |
     |                    |                    |                       | MCP stdio frame|
     |                    |                    |                       |..............>|
                                                                               Claude Code
                                                                               sees:
                                                                               <channel
                                                                                source="moltzap"
                                                                                chat_id="..."
                                                                                message_id="..."
                                                                                user="..."
                                                                                ts="...">
                                                                               content
                                                                               </channel>

Error taxonomy for this path:
  AllowlistError   — gateInbound returned Failure; logged, dropped (no push)
  EventShapeError  — toClaudeChannelNotification returned Err; logged, dropped
    ContentEmpty   — message text is blank
    MetaInvalid    — conversationId / id / sender.id / createdAt malformed
  PushError        — MCP emit rejected; logged, dropped (spec I5)
    EmitFailed     — server.notification() promise rejected
    NotConnected   — push called before transport attached (reserved, rare)
```

**Foreign-protocol bridge**: step D is the seam where MoltZap's wire
`EnrichedInboundMessage` becomes an MCP `notifications/claude/channel`
frame. The MCP SDK serialises it as JSON-RPC 2.0 over stdio.

---

See also:
- [Boot Sequence](01-boot-sequence.md)
- [Allowlist Gating](05-allowlist-gating.md)
- [Claude Reply → MoltZap Outbound](03-claude-reply-to-moltzap-outbound.md)
