# Channel Construction + registerChannel Hook

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The module-load side effect and constructor wiring happen in two distinct
phases: import time (registry registration) and instantiation time
(hook wiring inside `MoltZapChannel`).

**What nanoclaw does NOT have here vs openclaw-channel:**
- No persistence layer — no SQLite or event-log writes on connect.
- No group-sync RPC — `syncGroups()` is not implemented (method absent
  from the `Channel` interface stub in `types.ts`).
- No `setTyping()` implementation.
- The registry is a minimal stub (`channels/registry.ts`), not nanoclaw's
  real channel registry; `registeredChannelFactories` is only used in
  tests — the factory is never invoked by nanoclaw's router in this
  package.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  MODULE LOAD (import "channels/moltzap.ts")                         │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
                               │ channels/moltzap.ts → registerChannel call
                               ▼
              registerChannel("moltzap", factory)
                               │
                               │ channels/registry.ts → registeredChannelFactories.set
                               ▼
       registeredChannelFactories.set("moltzap", factory)
       ┌── idempotent: if same factory ref already stored, skip ──┐


  ┌─────────────────────────────────────────────────────────────────────┐
  │  INSTANTIATION (factory called, or test calls new MoltZapChannel)   │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
                               │ channels/moltzap.ts → loadMoltZapChannelEnv
                               ▼
                  loadMoltZapChannelEnv()
                  ┌─ Config.all({ apiKey, serverUrl, evalMode })
                  │  ConfigProvider.fromEnv()
                  │  MOLTZAP_API_KEY  → Option<Redacted>
                  │  MOLTZAP_SERVER_URL → string (default: wss://api.moltzap.xyz)
                  │  MOLTZAP_EVAL_MODE → "0"|"1" (default: "0")
                  └─ Effect.runSync (blocks; env is stable at load time)

                               │  apiKey absent → return null (no channel)
                               │  apiKey present ↓
                               ▼
              new MoltZapService({ serverUrl, agentKey: apiKey })
              new MoltZapChannelCore({ service })
              new MoltZapChannel(opts, core, service.ownAgentId, evalMode)

  ┌─────────────────────────────────────────────────────────────────────┐
  │  MoltZapChannel CONSTRUCTOR  (channels/moltzap.ts → constructor)    │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
    core.onInbound(…)   core.onDisconnect(…)  core.onReconnect(…)
    registers callback   Effect.runFork(      Effect.runFork(
    that calls             logWarning +         logInfo +
    handleInbound(msg)     annotateLogs)        annotateLogs)

  evalMode flag (boolean):
    false (default) → maybeAutoRegister() is a no-op
    true            → maybeAutoRegister() calls ensureAutoRegistered()
                      (smoke-test eval-pipeline convenience, §3.6)
```

---

Next: [02 — connect / disconnect Lifecycle](./02-connect-disconnect-lifecycle.md)
