# JID ↔ ConversationId Conversions

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The channel uses a lightweight prefix scheme. There is no registry lookup
or validation — conversions are pure string operations.

```mermaid
flowchart TD
    prefix["MOLTZAP_JID_PREFIX = &quot;mz:&quot;\n(channels/moltzap.ts)"]

    subgraph jidFrom["jidFromConversationId(conversationId)"]
        direction LR
        jf1["&quot;01960000-0000-7000-8000-000000000042&quot;"]
        jf2["&quot;mz:01960000-0000-7000-8000-000000000042&quot;"]
        jf1 -->|"return &quot;mz:&quot; + conversationId"| jf2
    end

    subgraph convFrom["conversationIdFromJid(jid)"]
        direction LR
        cf1["&quot;mz:01960000-0000-7000-8000-000000000042&quot;"]
        cf2["&quot;01960000-0000-7000-8000-000000000042&quot;"]
        cf1 -->|"jid.slice(3)"| cf2
    end

    subgraph owns["ownsJid(jid)"]
        direction LR
        o1["&quot;mz:anything&quot; → true"]
        o2["&quot;tg:1234&quot; → false"]
        o3["&quot;wa:5551234&quot; → false"]
        o4["&quot;conv-raw&quot; → false"]
    end

    prefix --> jidFrom
    prefix --> convFrom
    prefix --> owns

    jidFrom -->|"call site"| cs1["handleInbound (inbound path, §3.3)"]
    convFrom -->|"call site"| cs2["sendMessage (outbound path, §3.4)"]
    owns -->|"call sites"| cs3["sendMessage guard + nanoclaw router dispatch"]
```

**Why no regex?** The conversationId is a server-issued UUID. Slice is O(1), the prefix
is fixed, and there is no ambiguity — no other channel registered in
this package uses the `"mz:"` prefix. openclaw-channel uses the same
scheme; the smoke-test package intentionally mirrors it to catch
prefix-collision regressions.

---

Previous: [04 — Outbound sendMessage Flow](./04-outbound-send-message.md)
Next: [06 — Chat Metadata + Auto-Register](./06-chat-metadata-auto-register.md)
