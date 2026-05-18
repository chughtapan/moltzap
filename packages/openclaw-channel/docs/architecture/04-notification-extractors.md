# Notification Extractors (`mapping.ts`)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `service.on("rawNotification", …)` handler (registered in `openclaw-entry.ts →
startAccount`) runs a sequential dispatch chain. Each arm calls a pure extractor from
`src/mapping.ts` (now deleted; logic lives in the compiled dist —
the source was deleted in commit dabad82 but the extractor shapes are
preserved below from the last source revision).

Each extractor follows the same pattern:

```
extractXxx(frame: NotificationFrame): Result | null
  decodedNotification(frame)          ← Effect.runSync, returns Option
    decodeServerInbound(frame)
    flatMap: tag === "Notification" ? succeed : fail(NotANotificationFrameError)
    .option
  Option.match:
    onNone → null
    onSome → isFor(notification, XxxNotificationDefinition)
             ? notification.params.xxx : null
```

**arm 1 — conversationCreated**

```
extractConversationCreated(event)
  ← ConversationCreatedNotificationDefinition
  → { conversation: { id, type, name? } } | null
  on match:
    log.debug("conversation created ${id}")
    setStatus({ accountId, lastEventAt: Date.now() })
```

**arm 2 — conversationUpdated**

```
extractConversationUpdated(event)
  ← ConversationUpdatedNotificationDefinition
  → { conversation: { id, type, name? } } | null
  on match:
    log.debug("conversation updated ${id}")
    setStatus({ accountId, lastEventAt: Date.now() })
```

**arm 3 — contactRequest**

```
extractContactRequest(event)
  ← ContactRequestNotificationDefinition
  → { contact: { id, contactUserId } } | null
  on match:
    log.debug("contact request from ${contactUserId}")
    setStatus({ accountId, lastEventAt: Date.now() })
```

**arm 4 — contactAccepted**

```
extractContactAccepted(event)
  ← ContactAcceptedNotificationDefinition
  → { contact: { id, contactUserId } } | null
  on match:
    log.debug("contact accepted ${id}")
    setStatus({ accountId, lastEventAt: Date.now() })
```

**arm 5 — presenceChanged**

```
extractPresenceChanged(event)
  ← PresenceChangedNotificationDefinition
  → { agentId: string, status: string } | null
  on match:
    log.debug("${agentId} is now ${status}")
    setStatus({ accountId, lastEventAt: Date.now() })
```

All five arms are tried in order for every rawNotification frame. The
first matching arm executes, calls `return`, and subsequent arms are
skipped. The rawNotification handler is sync — it does NOT enter the
Effect runtime. setStatus is a direct call into OpenClaw's status API.

---

See also:
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — where `service.on("rawNotification", …)` is registered
- [03-inbound-on-inbound.md](03-inbound-on-inbound.md) — the separate inbound message path (messages/received, not notifications)
