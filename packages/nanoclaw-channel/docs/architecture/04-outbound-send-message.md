# Outbound sendMessage Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`sendMessage` is the reply path. It enforces JID ownership, looks up the
most recent dispatch lease for the JID, and calls `core.sendReply`.
Single-use lease semantics are enforced server-side (cutover #533).

```
  Caller (nanoclaw router)
       │
       │ channel.sendMessage(jid, text)       channels/moltzap.ts → sendMessage
       ▼
  Effect.runPromise(
    Effect.gen(this, function* () {

      ── ownership guard ──────────────────────────────────────────────
      if (!this.ownsJid(jid))                 channels/moltzap.ts → ownsJid guard
        yield* Effect.fail(
          new MoltZapChannelError({ reason: "...does not own jid: <jid>" })
        )   ← rejects immediately; no network call

      ── lease lookup ─────────────────────────────────────────────────
      leaseId = dispatchLeasesByJid.get(jid)  channels/moltzap.ts → lease lookup
        present  → { dispatchLeaseId: leaseId }
        absent   → {}  (unleased send; server accepts, no moderation
                        observability — valid for sends before first inbound)

      ── send ─────────────────────────────────────────────────────────
      yield* this.core.sendReply(             channels/moltzap.ts → core.sendReply
        conversationIdFromJid(jid),           strips "mz:" prefix (§3.5)
        text,
        leaseOpts
      ).pipe(
        Effect.mapError(
          (err: ServiceRpcError) => {
            if err instanceof RpcServerError
               && err.data.reason === "LeaseInvalid"
              → new MoltZapChannelError({ reason: "lease already consumed" })
            else
              → re-raise err unchanged
          }
        )
      )

      ── NO lease eviction ────────────────────────────────────────────
      // dispatchLeasesByJid entry is KEPT after send
      // Second sendMessage for same jid re-sends the consumed leaseId
      // → server returns RpcServerError(data.reason="LeaseInvalid")
      // → mapError converts to MoltZapChannelError("lease already consumed")

    })
  )

  Error taxonomy:
  ┌────────────────────────────────────────────────────────────────────┐
  │ MoltZapChannelError("...does not own jid...")                      │
  │   → ownsJid() returned false (wrong channel prefix)               │
  │ MoltZapChannelError("lease already consumed")                      │
  │   → server returned RpcServerError(reason="LeaseInvalid")         │
  │ ServiceRpcError (other)                                            │
  │   → transport / auth / network errors; propagated as-is           │
  └────────────────────────────────────────────────────────────────────┘
```

---

Previous: [03 — Inbound Flow](./03-inbound-flow.md)
Next: [05 — JID Conversions](./05-jid-conversions.md)
