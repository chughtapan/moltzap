# `deliver()` Error Handling — RpcServerError Discrimination

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

This is load-bearing. The wrong return value here causes OpenClaw to
retry (or not retry) the reply delivery. The code lives inside the
per-message `deliver` closure in `openclaw-entry.ts → onInbound, deliver`.

```
core.sendReply(conversationId, text)
  (calls service.send with dispatchLeaseId, in `openclaw-entry.ts → sendReply`)

       ┌─ SUCCESS ──────────────────────────────────────────────┐
       │  .tap(() => {                                           │
       │    consumedLeaseAt = Date.now()  ← lease now consumed  │
       │    log.info("outbound reply to …: ${text[:80]}")       │
       │  })                                                     │
       │  .map(() => true)  ← deliver returns true (delivered)  │
       └─────────────────────────────────────────────────────── ┘

       ┌─ FAILURE path 1: RpcServerError ──────────────────────────────┐
       │  .catchTag("RpcServerError", (err: RpcServerError) =>          │
       │                                                                │
       │    if err.code === TaskClosedError.code               (-32020) │
       │    ┌── TERMINAL: Task is closed ────────────────────────────── │
       │    │   log.warn({ conversationId, code, msg },                 │
       │    │             "send rejected — task closed, dropping")      │
       │    │   return true                                              │
       │    │   ─────────────────────────────────────────────────────── │
       │    │   WHY true? The lease is consumed on the server side.     │
       │    │   Returning true tells OpenClaw "delivered" so it does    │
       │    │   NOT retry. Retrying would create a new orphan send.     │
       │    │   This was the PR #587 fix: previously returned false,    │
       │    │   causing infinite retry loops on closed tasks.           │
       │    └─────────────────────────────────────────────────────────  │
       │    else                                                         │
       │    ┌── RETRY-ELIGIBLE: other RpcServerError ─────────────────  │
       │    │   log.error("failed to send reply: …")                    │
       │    │   return false                                             │
       │    │   ─────────────────────────────────────────────────────── │
       │    │   WHY false? Non-terminal server error (e.g. rate limit,  │
       │    │   transient server fault). OpenClaw may retry.            │
       │    └─────────────────────────────────────────────────────────  │
       └────────────────────────────────────────────────────────────── ┘

       ┌─ FAILURE path 2: any other error ─────────────────────────────┐
       │  .catchAll(err =>                                              │
       │    log.error("failed to send reply: …")                        │
       │    return false                                                 │
       │  )                                                             │
       │  (network drops, Effect runtime errors, etc.)                  │
       └────────────────────────────────────────────────────────────── ┘

       ▼
  Effect.runPromise(deliverEffect)
  ────────────────── Promise boundary ───────────────────────────────────
  Promise<boolean> → OpenClaw runtime
    true  = "delivered or terminal-consumed; do not retry"
    false = "delivery failed; retry eligible"

TaskClosedError.code:
  Defined in @moltzap/protocol/task.
  Wire value: -32020.
  Meaning: the server-side task context for this conversation is closed;
  no further messages can be sent. Terminal; must not retry.
```

---

See also:
- [03-inbound-on-inbound.md](03-inbound-on-inbound.md) — the full Effect chain in which the deliver closure lives
- [02-outbound-send-text.md](02-outbound-send-text.md) — the separate outbound sendText path (not reply delivery)
