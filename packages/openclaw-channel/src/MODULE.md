# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Package entry for tools that import the extension by package name.

OpenClaw discovers `dist/plugin.js` through package metadata. `dist/index.js`
gives other package consumers a stable default export without exposing
OpenClaw-specific types.

## Public surface

### [`default`](./plugin.ts#L826)

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
