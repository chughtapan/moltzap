# Outbound `sendText` — Promise Boundary

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
sequenceDiagram
    participant OC as OpenClaw runtime
    participant Entry as openclaw-entry.ts sendText
    participant Clients as activeClients Map
    participant Svc as MoltZapService

    OC->>Entry: outbound.sendText(ctx)<br>ctx = { cfg, to, text, accountId?, replyToId? }

    Note over Entry: Effect.gen — inside Effect world
    Entry->>Entry: accountId = ctx.accountId ?? "default"
    Entry->>Clients: activeClients.get(accountId)

    alt service not found
        Entry->>Entry: yield* Effect.fail(new MoltZapClientNotConnectedError({ accountId }))
    else ctx.to starts with "agent:"
        Entry->>Entry: agentName = to.slice("agent:".length)
        Entry->>Svc: service.sendToAgent(agentName, text, { replyTo: ctx.replyToId })
    else ctx.to starts with "conv:" or plain id
        Entry->>Entry: conversationId = to.startsWith("conv:") ? to.slice("conv:".length) : to
        Entry->>Svc: service.send(conversationId, text, { replyTo: ctx.replyToId })
    end

    Entry->>Entry: return new OpenClawSendTextSuccess()

    Note over Entry: .pipe(Effect.withSpan(...), Effect.match({<br>  onSuccess: ok => ok,<br>  onFailure: err => new OpenClawSendTextFailure({ error })<br>}))

    Note over Entry,OC: Effect.runPromise — Effect↔Promise boundary
    Entry-->>OC: Promise<OpenClawSendTextSuccess | OpenClawSendTextFailure><br>(never rejects — error channel collapsed by Effect.match)
```

**Key invariants:**
- `Effect.match` collapses the error channel — `runPromise` never rejects.
- `MoltZapClientNotConnectedError` is the only typed failure; all others
  (`ServiceRpcError` from `service.send`) propagate through `Effect.match`'s
  `onFailure` arm and become `OpenClawSendTextFailure`.
- The `"conv:"` strip + fallback-to-plain-id is backward compat for
  callers that pass a raw conversation UUID.

---

See also:
- [07-resolve-target.md](07-resolve-target.md) — `outbound.resolveTarget` validation runs before sendText
- [05-deliver-error-handling.md](05-deliver-error-handling.md) — the deliver callback that sends replies via the inbound path
