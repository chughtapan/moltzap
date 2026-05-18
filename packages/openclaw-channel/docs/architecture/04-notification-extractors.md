# Notification Extractors (`mapping.ts`)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `service.on("rawNotification", …)` handler (registered in `openclaw-entry.ts →
startAccount`) runs a sequential dispatch chain. Each arm calls a pure extractor from
`src/mapping.ts` (now deleted; logic lives in the compiled dist —
the source was deleted in commit dabad82 but the extractor shapes are
preserved below from the last source revision).

Each extractor follows the same pattern:

```mermaid
flowchart LR
    A["extractXxx(frame: NotificationFrame)"] --> B["decodedNotification(frame)<br>Effect.runSync → Option"]
    B --> C["decodeServerInbound(frame)<br>flatMap: tag === 'Notification'<br>  ? succeed : fail(NotANotificationFrameError)<br>.option"]
    C --> D{"Option.match"}
    D -->|onNone| E["return null"]
    D -->|onSome| F{"isFor(notification,<br>XxxNotificationDefinition)?"}
    F -->|no| E
    F -->|yes| G["return notification.params.xxx"]
```

**arm 1 — conversationCreated**

```mermaid
flowchart LR
    A["extractConversationCreated(event)<br>← ConversationCreatedNotificationDefinition"] --> B{"match?"}
    B -->|no| C["return null"]
    B -->|yes| D["{ conversation: { id, type, name? } }"]
    D --> E["log.debug('conversation created id')<br>setStatus({ accountId, lastEventAt: Date.now() })"]
```

**arm 2 — conversationUpdated**

```mermaid
flowchart LR
    A["extractConversationUpdated(event)<br>← ConversationUpdatedNotificationDefinition"] --> B{"match?"}
    B -->|no| C["return null"]
    B -->|yes| D["{ conversation: { id, type, name? } }"]
    D --> E["log.debug('conversation updated id')<br>setStatus({ accountId, lastEventAt: Date.now() })"]
```

**arm 3 — contactRequest**

```mermaid
flowchart LR
    A["extractContactRequest(event)<br>← ContactRequestNotificationDefinition"] --> B{"match?"}
    B -->|no| C["return null"]
    B -->|yes| D["{ contact: { id, contactUserId } }"]
    D --> E["log.debug('contact request from contactUserId')<br>setStatus({ accountId, lastEventAt: Date.now() })"]
```

**arm 4 — contactAccepted**

```mermaid
flowchart LR
    A["extractContactAccepted(event)<br>← ContactAcceptedNotificationDefinition"] --> B{"match?"}
    B -->|no| C["return null"]
    B -->|yes| D["{ contact: { id, contactUserId } }"]
    D --> E["log.debug('contact accepted id')<br>setStatus({ accountId, lastEventAt: Date.now() })"]
```

**arm 5 — presenceChanged**

```mermaid
flowchart LR
    A["extractPresenceChanged(event)<br>← PresenceChangedNotificationDefinition"] --> B{"match?"}
    B -->|no| C["return null"]
    B -->|yes| D["{ agentId: string, status: string }"]
    D --> E["log.debug('agentId is now status')<br>setStatus({ accountId, lastEventAt: Date.now() })"]
```

All five arms are tried in order for every rawNotification frame. The
first matching arm executes, calls `return`, and subsequent arms are
skipped. The rawNotification handler is sync — it does NOT enter the
Effect runtime. setStatus is a direct call into OpenClaw's status API.

---

See also:
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — where `service.on("rawNotification", …)` is registered
- [03-inbound-on-inbound.md](03-inbound-on-inbound.md) — the separate inbound message path (messages/received, not notifications)
