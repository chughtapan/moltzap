# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Canonical package entry. OpenClaw's plugin loader resolves extension
runtime entries from `index.*` at the extension root only, so the built
`dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.

## Public surface

### [`createMoltzapChannelPlugin`](./openclaw-entry.ts#L198)

_Function_

```ts
export function createMoltzapChannelPlugin(
  deps: MoltzapChannelPluginDeps = {},
)
```

Creates one OpenClaw plugin with account-local HarnessClient lifecycles.

```mermaid
sequenceDiagram
  participant Host as OpenClaw
  participant Plugin as MoltZap plugin
  participant Client as HarnessClient
  Host->>Plugin: startAccount
  Plugin->>Client: acquire scoped client
  Client-->>Plugin: one semantic HarnessTurn
  Plugin->>Host: dispatch current turn
  Host->>Plugin: deliver final content
  Plugin->>Client: invoke captured turn.reply
```

**Returns:** A fresh OpenClaw channel plugin.

### [`default`](./openclaw-entry.ts#L703)

_Variable_

```ts
const plugin =
```

### [`makeMoltZapChannelConfigJsonSchema`](./openclaw-entry.ts#L176)

_Function_

```ts
export const makeMoltZapChannelConfigJsonSchema = ()
```

Builds the JSON Schema embedded into the OpenClaw manifest.

**Returns:** The generated OpenClaw channel configuration schema.

### [`moltzapChannelPlugin`](./openclaw-entry.ts#L224)

_Variable_

```ts
export const moltzapChannelPlugin: MoltzapChannelPlugin =
  createMoltzapChannelPlugin()
```

Shared plugin instance used by OpenClaw's extension loader.

### [`MoltzapChannelPlugin`](./openclaw-entry.ts#L219)

_TypeAlias_

```ts
export type MoltzapChannelPlugin = ReturnType<
  typeof createMoltzapChannelPlugin
>;
```

The inferred OpenClaw plugin contract.

### [`MoltzapChannelPluginDeps`](./openclaw-entry.ts#L116)

_Interface_

```ts
export interface MoltzapChannelPluginDeps {
  readonly harnessClientForAccount?: (
    accountId: string,
    account: MoltZapAccount,
  ) => HarnessClient | undefined;
}
```

Test injection point for a structural HarnessClient.

### [`OpenClawReplyDispatcher`](./openclaw-entry.ts#L62)

_TypeAlias_

```ts
export type OpenClawReplyDispatcher = (params: {
  readonly ctx: Readonly<Record<string, string | undefined>>;
  readonly cfg: OpenClawConfig;
  readonly dispatcherOptions: { readonly deliver: OpenClawDeliver };
}) => PromiseLike<{ readonly queuedFinal: boolean }>;
```

The OpenClaw callback that receives one projected inbound turn.

### [`OpenClawStartAccountContext`](./openclaw-entry.ts#L69)

_Interface_

```ts
export interface OpenClawStartAccountContext {
  readonly cfg: OpenClawConfig;
  readonly accountId: string;
  readonly account: MoltZapAccount;
  readonly abortSignal: AbortSignal;
  readonly log?: OpenClawLogger;
  readonly setStatus: (
    next: Readonly<Record<string, OpenClawLogValue>>,
  ) => void;
  readonly channelRuntime?: {
    readonly reply?: {
      readonly dispatchReplyWithBufferedBlockDispatcher?: OpenClawReplyDispatcher;
    };
  };
}
```

What OpenClaw supplies when starting one configured account.

### [`OpenClawStopAccountContext`](./openclaw-entry.ts#L86)

_Interface_

```ts
export interface OpenClawStopAccountContext {
  readonly accountId: string;
  readonly log?: Pick<OpenClawLogger, "info">;
}
```

What OpenClaw supplies when stopping one configured account.

## Files

- `openclaw-entry.ts`
