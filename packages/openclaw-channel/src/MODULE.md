# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Canonical package entry. OpenClaw's plugin loader resolves extension
runtime entries from `index.*` at the extension root only, so the built
`dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.

## Public surface

### [`createMoltzapChannelPlugin`](./openclaw-entry.ts#L1318)

_Function_

```ts
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
)
```

Factory: returns a fresh plugin object whose `activeClients` map
lives in this closure. `register(api)` calls this so each
registration gets its own per-plugin state.

The plugin exposes the openclaw lifecycle hooks (`startAccount`,
`stopAccount`), the outbound `sendText`, the inbound `onInbound`
adapter (registered inside `startAccount`), the `deliver` callback,
and `resolveTarget` for openclaw's targeting layer.

```mermaid
sequenceDiagram
  participant OC as openclaw runtime
  participant Plugin as moltzap plugin
  participant Harness as caller-owned HarnessClient
  participant Core as MoltZapChannelCore
  participant Server as MoltZap server
  OC->>Plugin: startAccount(ctx)
  alt HarnessClient is injected
    Plugin->>Harness: drain turns sequentially
    Harness-->>Plugin: originating HarnessTurn
  else legacy profile client
    Plugin->>Core: new MoltZapAgentClient → MoltZapChannelCore
    Plugin->>Core: core.connect() — WS auth
    Plugin->>Core: core.onInbound(handler) — register dispatch
    Core->>Plugin: enriched message arrives
    Plugin->>Plugin: bind HarnessTurn reply authority
  end
  Plugin->>OC: dispatchReplyWithBufferedBlockDispatcher
  note over OC: agent pipeline → LLM
  OC->>Plugin: deliver(payload, opts) — createHarnessReplyDeliver
  Plugin->>Plugin: turn.reply(text)
  Plugin->>Server: core ingress bridge sends reply
  OC->>Plugin: stopAccount(ctx)
  Plugin->>Plugin: stop owned drain or disconnect owned core
```

`deliver` returns `PromiseLike&lt;boolean>` per openclaw contract;
false signals a failed send without throwing.

`resolveTarget` accepts a plain agent name or `agent:&lt;name>` for a DM and
`conv:&lt;conversationId>` for an existing conversation. Plain names normalize
to `agent:&lt;name>`. Other colon-prefixed shapes are rejected.

**Returns:** The created moltzap channel plugin.

### [`default`](./openclaw-entry.ts#L1349)

_Variable_

```ts
const plugin =
```

### [`moltzapChannelPlugin`](./openclaw-entry.ts#L1346)

_Variable_

```ts
export const moltzapChannelPlugin: MoltzapChannelPlugin =
  createMoltzapChannelPlugin()
```

Shared singleton so a single registration reuses the same `activeClients`
closure across `startAccount` and `sendText`. Tests import this directly
to assert against that shared state.

### [`MoltzapChannelPlugin`](./openclaw-entry.ts#L1337)

_TypeAlias_

```ts
export type MoltzapChannelPlugin = ReturnType<
  typeof createMoltzapChannelPlugin
>;
```

Represents moltzap channel plugin values.

## Files

- `openclaw-entry.ts`
