# Lease Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The `LeaseRegistry` is an in-process `Ref<Map<LeaseId, LeaseEntry>>` with
per-lease TTL fibers; no DB row. State transitions are atomic via `Ref.modify`:

```mermaid
stateDiagram-v2
    [*] --> PENDING

    PENDING --> GRANTED : moderator verdict (grant)
    PENDING --> DENIED : moderator deny
    PENDING --> HOLD : moderator returned hold
    PENDING --> ABANDONED : conn close

    HOLD --> PENDING : retry on next inbound message in same conversation (re-park)

    GRANTED --> CLAIMED : messages/send claim
    GRANTED --> EXPIRED : TTL fires OR conn close (GRANTED/HOLD)
    HOLD --> EXPIRED : conn close

    CLAIMED --> CONSUMED : insert ok
    CLAIMED --> GRANTED : insert fail (rollback)

    CONSUMED --> [*]
    DENIED --> [*]
    ABANDONED --> [*]
    EXPIRED --> [*]
```

The eight terminal/non-terminal states (PENDING, CLAIMED, GRANTED,
CONSUMED, DENIED, EXPIRED, ABANDONED, HOLD) match `LeaseState` in
`app/lease-registry.ts:111-118`. Connection-close GRANTED/HOLD transitions
go to plain EXPIRED — there is no distinct `EXPIRED_ON_DISCONNECT` state.

```mermaid
sequenceDiagram
    participant Recv as Recipient (client)
    participant AH as apps.handlers
    participant LR as LeaseRegistry
    participant Mod as Moderator (round-trip)
    participant MS as MessageService

    Recv->>AH: dispatch/request (C→S)
    AH->>LR: LeaseRegistry.mint(ctx)
    LR-->>AH: {leaseId, dispatchId} — state: PENDING
    AH-->>Recv: ack returned IMMEDIATELY (no wait on moderator)
    AH->>Mod: Effect.fork: dispatchAuthorizeHook(ctx)<br>(moderator round-trip — see §04 server-initiated callback)
    Mod-->>AH: verdict
    AH->>LR: LeaseRegistry.resolve(leaseId, verdict)
    LR-->>AH: state → GRANTED | DENIED | HOLD
    AH->>Recv: emit dispatch/release{verdict}

    Note over Recv: recipient parks client-side—<br>when release arrives, runs InboundHandler

    Recv->>MS: messages/send with dispatchLeaseId
    MS->>LR: LeaseRegistry.claim(leaseId)
    LR-->>MS: Claim handle — state: GRANTED → CLAIMED
    Note over MS: Effect.acquireUseRelease(<br>acquire = claim,<br>use = messageService.sendInsert(…) → carrier,<br>release = exit →<br>  if Exit.isSuccess → claim.finalize(messageId) CLAIMED→CONSUMED<br>  else → claim.rollback() CLAIMED→GRANTED<br>)
    MS->>MS: messageService.sendCommit(carrier, …)
    Note over MS: post-insert side effects: TM routing + broadcast + trace<br>do NOT affect lease state.<br>sendCommit failure leaves lease CONSUMED and durable<br>row intact — caller must not retry.
```

Connection close cleanup (`leaseRegistry.abandon(connId)` in the disconnect
finalizer): scans all leases bound to that connection, walks the same
table — PENDING→ABANDONED, GRANTED/HOLD→EXPIRED, CLAIMED
no-op. The CLAIMED no-op is load-bearing — without it, a recipient
disconnect mid-insert could roll back a committed durable row, permitting
a duplicate retry.

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — where `leaseRegistry.abandon` is called in the disconnect finalizer
- [§04 Server-initiated callback](./04-server-initiated-callback.md) — moderator round-trip that produces the verdict
- [§05 AppHost hook unification](./05-app-host-hook-unification.md) — how verdicts are shaped by `wrapHookEffectWithEnvelope`
