# `deliver()` Error Handling — RpcServerError Discrimination

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

This is load-bearing. The wrong return value here causes OpenClaw to
retry (or not retry) the reply delivery. The code lives inside the
per-message `deliver` closure in `openclaw-entry.ts → onInbound, deliver`.

```mermaid
flowchart TD
    A["core.sendReply(conversationId, text)\n(calls service.send with dispatchLeaseId,\nopenclaw-entry.ts → sendReply)"]

    A --> B{"Outcome"}

    B -->|SUCCESS| C[".tap(() => {\n  consumedLeaseAt = Date.now()\n  log.info('outbound reply to …: text[:80]')\n})\n.map(() => true)"]

    B -->|"FAILURE: RpcServerError\n.catchTag('RpcServerError')"| D{"err.code ===\nTaskClosedError.code\n(-32020)?"}

    D -->|yes — TERMINAL| E["log.warn({ conversationId, code, msg },\n'send rejected — task closed, dropping')\nreturn true"]
    E --> F["WHY true? Lease is consumed server-side.\nReturning true tells OpenClaw 'delivered'\nso it does NOT retry. Retrying would create\na new orphan send.\n(PR #587 fix: previously returned false,\ncausing infinite retry loops on closed tasks.)"]

    D -->|no — RETRY-ELIGIBLE| G["log.error('failed to send reply: …')\nreturn false"]
    G --> H["WHY false? Non-terminal server error\n(e.g. rate limit, transient server fault).\nOpenClaw may retry."]

    B -->|"FAILURE: any other error\n.catchAll(err)"| I["log.error('failed to send reply: …')\nreturn false\n(network drops, Effect runtime errors, etc.)"]

    C --> J["Effect.runPromise(deliverEffect)\n— Effect↔Promise boundary —"]
    F --> J
    H --> J
    I --> J

    J --> K["Promise&lt;boolean&gt; → OpenClaw runtime\ntrue  = delivered or terminal-consumed; do not retry\nfalse = delivery failed; retry eligible"]

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
