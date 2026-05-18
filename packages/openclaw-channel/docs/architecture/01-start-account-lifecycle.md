# `startAccount` Lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```
OpenClaw runtime
      │
      │  gateway.startAccount(ctx)
      │  ctx = { accountId, account, abortSignal,
      │           log, setStatus, channelRuntime }
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  Guard: account.apiKey && account.serverUrl              │
│  → missing? log.error + return Promise.resolve()         │
└─────────────────────────────────────────────────────────┘
      │
      ▼
  adaptOpenClawLogger(log.*)
  (reorders structured-log args to match OpenClaw's shape)
      │
      ▼
  new MoltZapService({ serverUrl, agentKey, logger })
  (WsClient + socket-server wrapper; entry into @moltzap/client)
      │
      ▼
  new MoltZapChannelCore({ service, logger })
  (registers internal listeners; forks consumerFiber)
      │
      ├─ core.onInbound(handler)
      │    handler body is the huge Effect.gen block (§3.3)
      │    → see 03-inbound-on-inbound.md
      │
      ├─ service.on("rawNotification", …)
      │    sync dispatcher → mapping extractors
      │    → see 04-notification-extractors.md
      │
      ├─ core.onDisconnect(() => { … })
      │    log.warn + setStatus({ connected:false,
      │                           lastDisconnect:{at:now} })
      │
      └─ core.onReconnect(() => { … })
           log.info + setStatus({ connected:true,
                                  lastConnectedAt:now })
      │
      ▼
  activeClients.set(accountId, service)   (in `openclaw-entry.ts`)
      │
      ├─[aborted already?]
      │    Effect.runPromise(
      │      core.disconnect()
      │        .tap(() => activeClients.delete(accountId))
      │    )
      │    → return that Promise (short-circuit)
      │
      └─[not yet aborted]
           │
           abortSignal.addEventListener("abort", { once }, …)
           handler: Effect.runPromise(core.disconnect())
                    activeClients.delete(accountId)
           │
           ▼
        Effect.runPromise(
          core.connect()                    ← Effect boundary
            .tap(() =>
              service.startSocketServer()
              log.info("connected as …")
              setStatus({ connected:true, … })
            )
            .zipRight(waitForAbort(abortSignal))
            .catchAll(err =>
              log.error("connection failed: …")
              Effect.fail(err)
            )
        )
        ──────────────────────────────────────────────────►
        Promise returned to OpenClaw runtime.
        Promise resolves only when AbortSignal fires.
        (This is a long-lived "lifecycle" promise, not a
         one-shot async action.)

Abort handling detail
─────────────────────
  Two code paths cover the abort race:

  Path A — signal already aborted when startAccount runs
    Effect.runPromise(core.disconnect() + delete) returned immediately;
    the long-lived promise is never started.

  Path B — signal fires after startAccount is running
    "abort" listener calls:
      void Effect.runPromise(core.disconnect())
      activeClients.delete(accountId)
    The zipRight(waitForAbort(abortSignal)) branch in the running
    promise then resolves (waitForAbort registers one "abort" listener;
    if already aborted, resumes synchronously).

  waitForAbort internals (in `openclaw-entry.ts → waitForAbort`):
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
