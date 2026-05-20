# Outbound sendMessage Flow

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`sendMessage` is the reply path. It enforces JID ownership, looks up the
most recent dispatch lease for the JID, and calls `core.sendReply`.
Single-use lease semantics are enforced server-side (cutover #533).

```mermaid
flowchart TD
    A["Caller (nanoclaw router)<br>channel.sendMessage(jid, text)"]
    A -->|"channels/moltzap.ts → sendMessage"| B["Effect.runPromise(Effect.gen(...))"]

    B --> C{"ownsJid(jid)?<br>channels/moltzap.ts → ownsJid guard"}
    C -->|"false"| D["Effect.fail(<br>  MoltZapChannelError({ reason: &quot;...does not own jid: &lt;jid&gt;&quot; })<br>)<br>← rejects immediately; no network call"]
    C -->|"true"| E["leaseId = leaseStore.peek(jid)<br>channels/moltzap.ts → lease lookup"]

    E -->|"present"| F["leaseOpts = { dispatchLeaseId: leaseId }"]
    E -->|"absent"| G["leaseOpts = {}<br>(unleased send; server accepts, no moderation<br>observability — valid for sends before first inbound)"]

    F --> H["core.sendReply(<br>  conversationIdFromJid(jid),<br>  text,<br>  leaseOpts<br>)<br>strips &quot;mz:&quot; prefix (§3.5)"]
    G --> H

    H -->|"RpcServerError(reason=&quot;LeaseInvalid&quot;)"| I["LeaseAlreadyConsumed (channel-base)"]
    H -->|"other ServiceRpcError"| J["re-raise err unchanged"]
    H -->|"success"| K["resolves<br>(leaseStore entry KEPT after send —<br>second send re-uses consumed leaseId → LeaseInvalid)"]
```

**Error taxonomy:**

- `MoltZapChannelError("...does not own jid...")` — `ownsJid()` returned false (wrong channel prefix)
- `LeaseAlreadyConsumed (channel-base)` — server returned `RpcServerError(reason="LeaseInvalid")`
- `ServiceRpcError` (other) — transport / auth / network errors; propagated as-is

---

Previous: [Inbound Flow](./inbound-flow.md)
Next: [JID Conversions](./jid-conversions.md)
