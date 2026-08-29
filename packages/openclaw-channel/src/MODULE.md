# openclaw-channel/src

_`packages/openclaw-channel/src`_

## Purpose

Canonical package entry. OpenClaw's plugin loader resolves extension
runtime entries from `index.*` at the extension root only, so the built
`dist/index.js` must exist; the implementation lives in `openclaw-entry.ts`.

## Public surface

### [`default`](./openclaw-entry.ts#L821)

_Variable_

```ts
const plugin =
```

### [`makeMoltZapChannelConfigJsonSchema`](./openclaw-entry.ts#L179)

_Function_

```ts
export function makeMoltZapChannelConfigJsonSchema()
```

Returns the manifest schema for one MoltZap channel configuration.

**Returns:** The JSON Schema embedded in the OpenClaw plugin manifest.

## Files

- `openclaw-entry.ts`
