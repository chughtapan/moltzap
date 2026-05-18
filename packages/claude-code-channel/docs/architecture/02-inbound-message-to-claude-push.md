# Inbound Message → Claude Push

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

When the WS connection delivers a message, `MoltZapChannelCore` calls every
registered `onInbound` callback. The channel registered one at boot step 7.

```mermaid
sequenceDiagram
    participant WS as MoltZap server
    participant client as @moltzap/client
    participant entry as entry.ts
    participant event as event.ts
    participant server as server.ts
    participant Claude as Claude Code

    WS-->>client: WS frame → MoltZapChannelCore
    client->>entry: onInbound(enriched) — handleInboundMessage

    note over entry: [A] opts.gateInbound?
    alt gate present
        entry->>entry: gateInbound(enriched) — pure, sync (types.ts)
        alt { _tag:"Failure" }
            note over entry: logGateDropped (AllowlistError)<br>logged only, not propagated — return
        end
    end
    note over entry: NO gate / { _tag:"Success" } — continue

    entry->>event: [B] toClaudeChannelNotification(gated.value)

    note over event: [B1] content check<br>event.text empty → { _tag:"Err", ContentEmpty }<br>logTranslationFailed + return

    note over event: [B2] decodeNotificationMeta<br>chat_id = conversationId<br>message_id = id<br>user = sender.id<br>ts = createdAt (ISO)<br>any brand fails → MetaInvalid / ContentEmpty<br>logTranslationFailed + return

    event-->>entry: ClaudeChannelNotification

    note over entry: [C] routing.recordInbound(message_id, chat_id)<br>advances lastActive, inserts into LRU map (cap 256)

    entry->>server: [D] serverHandle.push(notification)

    alt state.initialized == false (pre-handshake)
        note over server: state.pending.push()<br>flushed later at oninitialized
    else state.initialized == true
        server->>server: server.notification({<br>  method: "notifications/claude/channel",<br>  params: { content, meta }<br>})
        alt EmitFailed
            note over server: logWarning — swallowed (entry.ts)
        end
        server-->>Claude: MCP stdio frame
    end

    Note over Claude: <channel source="moltzap" chat_id="..." message_id="..." user="..." ts="..."><br>content<br></channel>
```

Error taxonomy for this path:
  AllowlistError   — gateInbound returned Failure; logged, dropped (no push)
  EventShapeError  — toClaudeChannelNotification returned Err; logged, dropped
    ContentEmpty   — message text is blank
    MetaInvalid    — conversationId / id / sender.id / createdAt malformed
  PushError        — MCP emit rejected; logged, dropped (spec I5)
    EmitFailed     — server.notification() promise rejected
    NotConnected   — push called before transport attached (reserved, rare)

**Foreign-protocol bridge**: step D is the seam where MoltZap's wire
`EnrichedInboundMessage` becomes an MCP `notifications/claude/channel`
frame. The MCP SDK serialises it as JSON-RPC 2.0 over stdio.

---

See also:
- [Boot Sequence](01-boot-sequence.md)
- [Allowlist Gating](05-allowlist-gating.md)
- [Claude Reply → MoltZap Outbound](03-claude-reply-to-moltzap-outbound.md)
