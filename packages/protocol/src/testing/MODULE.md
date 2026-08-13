# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — test fixture constructors.

## Public surface

### [`agentId`](./index.ts#L56)

_Function_

```ts
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema>
```

Validates and decodes agent id values.

**Returns:** The agent id result.

### [`agentKeyString`](./index.ts#L92)

_Function_

```ts
export const agentKeyString = (seed: number): string
```

Provides the agent key string runtime value.

**Returns:** A reproducible full agent-key string.

### [`messageId`](./index.ts#L65)

_Function_

```ts
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema>
```

Validates and decodes message id values.

**Returns:** The message id result.

### [`redactedAgentKey`](./index.ts#L85)

_Function_

```ts
export const redactedAgentKey = (value: string): AgentKey
```

Validates and decodes redacted agent key values.

**Returns:** The redacted agent key result.

### [`userId`](./index.ts#L47)

_Function_

```ts
export const userId = (
  value: string,
): Schema.Schema.Type<typeof userIdSchema>
```

Validates and decodes user id values.

**Returns:** The user id result.

## Files

- `index.ts`
