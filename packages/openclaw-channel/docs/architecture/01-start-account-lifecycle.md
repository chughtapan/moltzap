# `startAccount` Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
sequenceDiagram
    participant OC as OpenClaw runtime
    participant Entry as openclaw-entry.ts
    participant Svc as MoltZapService
    participant Core as MoltZapChannelCore

    OC->>Entry: gateway.startAccount(ctx)<br/>ctx = { accountId, account, abortSignal,<br/>         log, setStatus, channelRuntime }

    Entry->>Entry: Guard: account.apiKey && account.serverUrl<br/>missing? log.error + return Promise.resolve()

    Entry->>Entry: adaptOpenClawLogger(log.*)<br/>(reorders structured-log args to match OpenClaw's shape)

    Entry->>Svc: new MoltZapService({ serverUrl, agentKey, logger })<br/>(WsClient + socket-server wrapper; entry into @moltzap/client)

    Entry->>Core: new MoltZapChannelCore({ service, logger })<br/>(registers internal listeners; forks consumerFiber)

    Entry->>Core: core.onInbound(handler)<br/>handler body is the Effect.gen block<br/>→ see 03-inbound-on-inbound.md

    Entry->>Svc: service.on("rawNotification", …)<br/>sync dispatcher → mapping extractors<br/>→ see 04-notification-extractors.md

    Entry->>Core: core.onDisconnect(() => { … })<br/>log.warn + setStatus({ connected:false, lastDisconnect:{at:now} })

    Entry->>Core: core.onReconnect(() => { … })<br/>log.info + setStatus({ connected:true, lastConnectedAt:now })

    Entry->>Entry: activeClients.set(accountId, service)

    alt aborted already?
        Entry->>Core: Effect.runPromise(core.disconnect()<br/>  .tap(() => activeClients.delete(accountId)))
        Note over Entry: short-circuit — return that Promise immediately
    else not yet aborted
        Entry->>Entry: abortSignal.addEventListener("abort", { once }, …)<br/>handler: Effect.runPromise(core.disconnect())<br/>         activeClients.delete(accountId)
        Note over Entry,OC: Effect.runPromise — Effect↔Promise boundary
        Entry->>Core: core.connect()<br/>  .tap(() => startSocketServer, log.info, setStatus)<br/>  .zipRight(waitForAbort(abortSignal))<br/>  .catchAll(err => log.error + Effect.fail(err))
        Entry-->>OC: Promise (long-lived lifecycle promise)<br/>resolves only when AbortSignal fires
    end
```

**Abort handling detail**

Two code paths cover the abort race:

- **Path A** — signal already aborted when `startAccount` runs:
  `Effect.runPromise(core.disconnect() + delete)` returned immediately;
  the long-lived promise is never started.

- **Path B** — signal fires after `startAccount` is running:
  "abort" listener calls `void Effect.runPromise(core.disconnect())` and
  `activeClients.delete(accountId)`. The `zipRight(waitForAbort(abortSignal))`
  branch in the running promise then resolves (`waitForAbort` registers one
  "abort" listener; if already aborted, resumes synchronously).

`waitForAbort` internals (in `openclaw-entry.ts → waitForAbort`):
```ts
Effect.async<void>(resume => {
  if (signal.aborted) { resume(Effect.void); return; }
  signal.addEventListener("abort", () => resume(Effect.void),
                          { once: true });
})
```

---

See also:
- [06-stop-account-lifecycle.md](06-stop-account-lifecycle.md) — teardown counterpart
- [03-inbound-on-inbound.md](03-inbound-on-inbound.md) — the onInbound handler registered here
- [04-notification-extractors.md](04-notification-extractors.md) — the rawNotification dispatcher registered here
