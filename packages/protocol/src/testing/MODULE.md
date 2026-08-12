# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — test fixtures and assertion helpers.

## Public surface

### [`agentId`](./test-fixtures.ts#L67)

_Function_

```ts
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema>
```

Validates and decodes agent id values.

**Returns:** The agent id result.

### [`agentKeyArbitrary`](./test-fixtures.ts#L117)

_Variable_

```ts
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey)
```

Provides the agent key arbitrary runtime value.

### [`agentKeyString`](./test-fixtures.ts#L124)

_Function_

```ts
export const agentKeyString = (seed: number): string
```

Provides the agent key string runtime value.

**Returns:** The agent key string result.

### [`agentKeyStringArbitrary`](./test-fixtures.ts#L104)

_Variable_

```ts
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`)
```

Provides the agent key string arbitrary runtime value.

### [`agentName`](./test-fixtures.ts#L76)

_Function_

```ts
export const agentName = (
  value: string,
): Schema.Schema.Type<typeof agentNameSchema>
```

Validates and decodes agent name values.

**Returns:** The agent name result.

### [`connectionId`](./test-fixtures.ts#L132)

_Variable_

```ts
export const connectionId = decodeConnectionId
```

Provides the connection id runtime value.

### [`conversationId`](./test-fixtures.ts#L85)

_Function_

```ts
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof conversationIdSchema>
```

Validates and decodes conversation id values.

**Returns:** The conversation id result.

### [`messageId`](./test-fixtures.ts#L94)

_Function_

```ts
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema>
```

Validates and decodes message id values.

**Returns:** The message id result.

### [`redactedAgentKey`](./test-fixtures.ts#L114)

_Function_

```ts
export const redactedAgentKey = (value: string): AgentKey
```

Validates and decodes redacted agent key values.

**Returns:** The redacted agent key result.

### [`userId`](./test-fixtures.ts#L58)

_Function_

```ts
export const userId = (
  value: string,
): Schema.Schema.Type<typeof userIdSchema>
```

Validates and decodes user id values.

**Returns:** The user id result.

## Files

- `test-fixtures.ts`
