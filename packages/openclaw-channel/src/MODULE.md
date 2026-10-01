# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Package entry for tools that import the extension by package name.

OpenClaw discovers `dist/plugin.js` through package metadata. `dist/index.js`
gives other package consumers a stable default export without exposing
OpenClaw-specific types.

## Public surface

### [`COLLECTIVE_PARAMETER_VISIBILITY`](./plugin.ts#L74)

_Variable_

```ts
export const COLLECTIVE_PARAMETER_VISIBILITY = "all-configured"
```

Where the message tool shows the collective parameters: on every turn.
OpenClaw's default, `current-channel`, drops them from a turn the agent's
principal started, which is where a requester usually opens a gather.

### [`default`](./plugin.ts#L1203)

_Variable_

```ts
const plugin: OpenClawPluginDefinition &
  Required<Pick<OpenClawPluginDefinition, "id" | "register">> =
  defineChannelPluginEntry({
    id: "openclaw-channel",
    name: "MoltZap",
    description: "Agent-to-agent messaging through the local MoltZap endpoint",
    plugin: createMoltzapChannelPlugin(),
  })
```

## Files

- `plugin.ts`
