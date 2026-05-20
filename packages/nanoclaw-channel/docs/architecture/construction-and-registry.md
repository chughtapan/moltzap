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

```mermaid
flowchart TD
    A["MODULE LOAD<br>import &quot;channels/moltzap.ts&quot;"]
    A -->|"channels/moltzap.ts → registerChannel call"| B["registerChannel(&quot;moltzap&quot;, factory)"]
    B -->|"channels/registry.ts → registeredChannelFactories.set"| C["registeredChannelFactories.set(&quot;moltzap&quot;, factory)<br>(idempotent: if same factory ref already stored, skip)"]

    D["INSTANTIATION<br>(factory called, or test calls new MoltZapChannel)"]
    D -->|"channels/moltzap.ts → loadMoltZapChannelEnv"| E["loadMoltZapChannelEnv()<br>Config.all({ apiKey, serverUrl, evalMode })<br>ConfigProvider.fromEnv()<br>MOLTZAP_API_KEY → Option&lt;Redacted&gt;<br>MOLTZAP_SERVER_URL → string (default: wss://api.moltzap.xyz)<br>MOLTZAP_EVAL_MODE → &quot;0&quot;|&quot;1&quot; (default: &quot;0&quot;)<br>Effect.runSync (blocks; env is stable at load time)"]
    E -->|"apiKey absent"| F["return null (no channel)"]
    E -->|"apiKey present"| G["new MoltZapService({ serverUrl, agentKey: apiKey })<br>new MoltZapChannelCore({ service })<br>new MoltZapChannel(opts, core, service.ownAgentId, evalMode)"]

    G --> H["MoltZapChannel CONSTRUCTOR<br>(channels/moltzap.ts → constructor)"]
    H --> I["core.onInbound(…)<br>registers callback<br>that calls handleInbound(msg)"]
    H --> J["core.onDisconnect(…)<br>Effect.runFork(<br>  logWarning + annotateLogs)"]
    H --> K["core.onReconnect(…)<br>Effect.runFork(<br>  logInfo + annotateLogs)"]

    H --> L{"evalMode flag"}
    L -->|"false (default)"| M["maybeAutoRegister() is a no-op"]
    L -->|"true"| N["maybeAutoRegister() calls ensureAutoRegistered()<br>(smoke-test eval-pipeline convenience, §3.6)"]
```

---

Next: [connect / disconnect Lifecycle](./connect-disconnect-lifecycle.md)
