# emitChatMetadata + ensureAutoRegistered

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`emitChatMetadata` fires on every inbound message, always before
`onMessage` (enforced by call order in `handleInbound`, §3.3).
`ensureAutoRegistered` is an eval-mode-only side effect that mutates
nanoclaw's live `registeredGroups` map.

```
  emitChatMetadata(chatJid, enriched)          channels/moltzap.ts → emitChatMetadata
       │
       ▼  opts.onChatMetadata({
            chatJid,                           e.g. "mz:<uuid>"
            timestamp: enriched.createdAt,     ISO-8601 string
            name: enriched.conversationMeta?.name,   undefined for DMs
            channel: "moltzap",
            isGroup: enriched.conversationMeta?.type === "group"
          })
       │
       ▼  nanoclaw router indexes the chat record;
          subsequent message delivery uses this metadata for routing

  ensureAutoRegistered (evalMode=true path)    channels/moltzap.ts → ensureAutoRegistered
       │
       ▼  registered = opts.registeredGroups()  // live map reference
          if registered[chatJid] exists → return immediately (idempotent)
          else:
            registered[chatJid] = {
              name:    "eval-" + conversationId.slice(0, 8),
              folder:  "eval_" + conversationId.slice(0, 8),
              trigger: ".*",                   wildcard — fires on any text
              added_at: new Date().toISOString(),
              requiresTrigger: false,
              isMain: true,
            }
       │
       ▼  nanoclaw's router sees the new entry on next poll/deliver
          (no setter call; mutates the map object nanoclaw owns)

  State machine:
    ┌──────────────┐  first inbound  ┌──────────────────────────────┐
    │ unregistered │─────────────────▶ registered (eval-<8chars>,   │
    │              │  evalMode=true   │ trigger=".*", isMain=true)   │
    └──────────────┘                 └──────────────────────────────┘
                                              │
                                              │ subsequent inbound
                                              ▼
                                     registered[chatJid] exists → skip

  What nanoclaw does NOT do here (smoke-test minimalism):
    - No API call to fetch conversation membership.
    - No persistent registration store — lives only in the in-process map.
    - evalMode=false → registeredGroups() is never called; zero coupling
      to nanoclaw's group system in normal (non-eval) use.

  Constant: EVAL_GROUP_NAME_ID_CHARS = 8      (in channels/moltzap.ts)
```

---

Previous: [05 — JID Conversions](./05-jid-conversions.md)
Next: [07 — toNewMessage Projection](./07-to-new-message-projection.md)
