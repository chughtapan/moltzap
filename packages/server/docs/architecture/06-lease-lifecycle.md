# Lease Lifecycle (`#529` reshape)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `LeaseRegistry` is an in-process `Ref<Map<LeaseId, LeaseEntry>>` with
per-lease TTL fibers; no DB row. State transitions are atomic via `Ref.modify`:

```text
              ┌──────── lease state machine ────────────┐
              │                                          │
              ▼                                          │
          PENDING ───── moderator verdict ─────────────┐ │
              │                                        │ │
              │  conn close                            │ │
              ▼                                        ▼ │
          ABANDONED                              GRANTED │
                                                     │  │
                                      messages/send  │  │
                                      claim ────────▶│  │
                                                     ▼  │
                                                 CLAIMED│
                                                     │  │
                                        insert ok  ──┴─▶│ CONSUMED
                                                        │
                                        insert fail ──▶ │ rollback → GRANTED
                                                        │
                                          TTL fires  ──▶│ EXPIRED
                                                        │
                                   moderator deny ────▶ │ DENIED
                                                        │
                                   conn close (G/H) ──▶ │ EXPIRED-on-disconnect
              │
              ▼
          HOLD (moderator returned hold)
              │
              ▼ retry on next inbound message in same conversation
          [re-park → next verdict]
```

```text
Recipient flow (with lease):
   │
   ▼  dispatch/request (C→S)                  app/handlers/apps.handlers.ts
   │     ▼
   │   LeaseRegistry.mint(ctx) → {leaseId, dispatchId}     PENDING
   │     ▼
   │   ack returned IMMEDIATELY (no wait on moderator)
   │     ▼
   │   Effect.fork: dispatchAuthorizeHook(ctx)
   │     ↑  moderator round-trip (see §04 server-initiated callback)
   │     │
   │     ▼  verdict
   │   LeaseRegistry.resolve(leaseId, verdict)
   │     ▼  state → GRANTED | DENIED | HOLD
   │     ▼
   │   emit dispatch/release{verdict} to recipient connection
   │
   ▼ recipient parks client-side; when release arrives, runs InboundHandler
   ▼ handler invokes messages/send with dispatchLeaseId
   │
   ▼  messages/send handler:
   │     LeaseRegistry.claim(leaseId) → Claim handle      GRANTED → CLAIMED
   │     Effect.acquireUseRelease(
   │       acquire = claim,
   │       use     = messageService.sendInsert(...) → carrier,
   │       release = exit → if Exit.isSuccess
   │                          then claim.finalize(messageId)  CLAIMED → CONSUMED
   │                          else claim.rollback()           CLAIMED → GRANTED
   │     )
   │     messageService.sendCommit(carrier, ...)
   │     // post-insert side effects: TM routing + broadcast + trace
   │     // do NOT affect lease state. sendCommit failure leaves lease
   │     // CONSUMED and durable row intact — caller must not retry.
```

Connection close cleanup (`leaseRegistry.abandon(connId)` in the disconnect
finalizer): scans all leases bound to that connection, walks the same
table — PENDING→ABANDONED, GRANTED/HOLD→EXPIRED-on-disconnect, CLAIMED
no-op. The CLAIMED no-op is load-bearing — without it, a recipient
disconnect mid-insert could roll back a committed durable row, permitting
a duplicate retry.

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — where `leaseRegistry.abandon` is called in the disconnect finalizer
- [§04 Server-initiated callback](./04-server-initiated-callback.md) — moderator round-trip that produces the verdict
- [§05 AppHost hook unification](./05-app-host-hook-unification.md) — how verdicts are shaped by `wrapHookEffectWithEnvelope`
