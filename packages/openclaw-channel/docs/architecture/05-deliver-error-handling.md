# `deliver()` Error Handling — RpcServerError Discrimination

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

This is load-bearing. The wrong return value here causes OpenClaw to
retry (or not retry) the reply delivery. The code lives inside the
per-message `deliver` closure in `openclaw-entry.ts → onInbound, deliver`.

```mermaid
flowchart TD
    A["core.sendReply(conversationId, text)<br>(calls service.send with dispatchLeaseId,<br>openclaw-entry.ts → sendReply)"]

    A --> B{"Outcome"}

    B -->|SUCCESS| C[".tap(() => {<br>  consumedLeaseAt = Date.now()<br>  log.info('outbound reply to …: text[:80]')<br>})<br>.map(() => true)"]

    B -->|"FAILURE: RpcServerError<br>.catchTag('RpcServerError')"| D{"err.code ===<br>TaskClosedError.code<br>(-32020)?"}

    D -->|yes — TERMINAL| E["log.warn({ conversationId, code, msg },<br>'send rejected — task closed, dropping')<br>return true"]
    E --> F["WHY true? Lease is consumed server-side.<br>Returning true tells OpenClaw 'delivered'<br>so it does NOT retry. Retrying would create<br>a new orphan send.<br>(PR #587 fix: previously returned false,<br>causing infinite retry loops on closed tasks.)"]

    D -->|no — RETRY-ELIGIBLE| G["log.error('failed to send reply: …')<br>return false"]
    G --> H["WHY false? Non-terminal server error<br>(e.g. rate limit, transient server fault).<br>OpenClaw may retry."]

    B -->|"FAILURE: any other error<br>.catchAll(err)"| I["log.error('failed to send reply: …')<br>return false<br>(network drops, Effect runtime errors, etc.)"]

    C --> J["Effect.runPromise(deliverEffect)<br>— Effect↔Promise boundary —"]
    F --> J
    H --> J
    I --> J

    J --> K["Promise&lt;boolean&gt; → OpenClaw runtime<br>true  = delivered or terminal-consumed; do not retry<br>false = delivery failed; retry eligible"]

    style E fill:#fff3cd,stroke:#d4a
    style G fill:#fde,stroke:#d44
    style I fill:#fde,stroke:#d44
    style C fill:#dfd,stroke:#4a4
```

**Annotations:**

- `TaskClosedError.code`: Defined in `@moltzap/protocol/task`. Wire value: `-32020`. Meaning: the server-side task context for this conversation is closed; no further messages can be sent. Terminal; must not retry.

---

See also:
- [03-inbound-on-inbound.md](03-inbound-on-inbound.md) — the full Effect chain in which the deliver closure lives
- [02-outbound-send-text.md](02-outbound-send-text.md) — the separate outbound sendText path (not reply delivery)
