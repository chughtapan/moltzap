# Outbound `sendText` — Promise Boundary

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```
OpenClaw runtime
      │
      │  outbound.sendText(ctx)
      │  ctx = { cfg, to, text, accountId?, replyToId? }
      │
      ▼
┌──────────────────────────── Effect world ───────────────────────────────┐
│                                                                          │
│  Effect.gen(function* () {          (in `openclaw-entry.ts → sendText`) │
│    accountId = ctx.accountId ?? "default"                               │
│                                                                          │
│    service = activeClients.get(accountId)                               │
│    if (!service)                                                         │
│      yield* Effect.fail(                                                 │
│        new MoltZapClientNotConnectedError({ accountId })                │
│      )                                                                   │
│                                                                          │
│    ┌── branch: ctx.to starts with "agent:" ───────────────────────────┤ │
│    │   agentName = to.slice("agent:".length)                             │
│    │   yield* service.sendToAgent(agentName, text,                       │
│    │                              { replyTo: ctx.replyToId })            │
│    └──────────────────────────────────────────────────────────────────  │
│    ┌── branch: ctx.to starts with "conv:" (or plain id)  ─────────────┤ │
│    │   conversationId = to starts with "conv:"                           │
│    │                    ? to.slice("conv:".length) : to                  │
│    │   yield* service.send(conversationId, text,                         │
│    │                       { replyTo: ctx.replyToId })                   │
│    └──────────────────────────────────────────────────────────────────  │
│                                                                          │
│    return new OpenClawSendTextSuccess()                                  │
│                                                                          │
│  }).pipe(                                                                │
│    Effect.withSpan("createMoltzapChannelPlugin.sendText"),               │
│    Effect.match({                                                        │
│      onSuccess: ok  => ok,          ← OpenClawSendTextSuccess           │
│      onFailure: err => new OpenClawSendTextFailure({                     │
│                          error: err instanceof Error                     │
│                            ? err : new Error(String(err))               │
│                        })           ← wraps ALL failures                 │
│    })                                                                    │
│  )                                                                       │
│                                                                          │
└────────────────── Effect.runPromise(effect) ─────────────────────────── ┘
      │
      ▼   ◄── Promise boundary: Effect.runPromise called once
      Promise<OpenClawSendTextSuccess | OpenClawSendTextFailure>
      returned to OpenClaw runtime

Key invariants:
  • Effect.match collapses the error channel — runPromise never rejects.
  • MoltZapClientNotConnectedError is the only typed failure; all others
    (ServiceRpcError from service.send) propagate through Effect.match's
    onFailure arm and become OpenClawSendTextFailure.
  • The "conv:" strip + fallback-to-plain-id is backward compat for
    callers that pass a raw conversation UUID.
```

---

See also:
- [07-resolve-target.md](07-resolve-target.md) — `outbound.resolveTarget` validation runs before sendText
- [05-deliver-error-handling.md](05-deliver-error-handling.md) — the deliver callback that sends replies via the inbound path
