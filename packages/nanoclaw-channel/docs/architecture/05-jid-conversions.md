# JID ↔ ConversationId Conversions

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The channel uses a lightweight prefix scheme. There is no registry lookup
or validation — conversions are pure string operations.

```
  CONSTANT
    MOLTZAP_JID_PREFIX = "mz:"                channels/moltzap.ts → MOLTZAP_JID_PREFIX

  jidFromConversationId(conversationId)        channels/moltzap.ts → jidFromConversationId
    return "mz:" + conversationId

    Example:
      "01960000-0000-7000-8000-000000000042"
      → "mz:01960000-0000-7000-8000-000000000042"

  conversationIdFromJid(jid)                   channels/moltzap.ts → conversationIdFromJid
    return jid.slice("mz:".length)   // slice(3)

    Example:
      "mz:01960000-0000-7000-8000-000000000042"
      → "01960000-0000-7000-8000-000000000042"

  ownsJid(jid)                                 channels/moltzap.ts → ownsJid
    return jid.startsWith("mz:")

    "mz:anything"  → true
    "tg:1234"      → false
    "wa:5551234"   → false
    "conv-raw"     → false

  Why no regex?
    The conversationId is a server-issued UUID. Slice is O(1), the prefix
    is fixed, and there is no ambiguity — no other channel registered in
    this package uses the "mz:" prefix. openclaw-channel uses the same
    scheme; the smoke-test package intentionally mirrors it to catch
    prefix-collision regressions.

  Call sites:
    jidFromConversationId  → handleInbound (inbound path, §3.3)
    conversationIdFromJid  → sendMessage (outbound path, §3.4)
    ownsJid                → sendMessage guard + nanoclaw router dispatch
```

---

Previous: [04 — Outbound sendMessage Flow](./04-outbound-send-message.md)
Next: [06 — Chat Metadata + Auto-Register](./06-chat-metadata-auto-register.md)
