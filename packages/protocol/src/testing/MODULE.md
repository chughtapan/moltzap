# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — test fixtures and assertion helpers.

## Public surface

### [`agentId`](./test-fixtures.ts#L89)

_Function_

```ts
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema>
```

Validates and decodes agent id values.

**Returns:** The agent id result.

### [`agentKeyArbitrary`](./test-fixtures.ts#L139)

_Variable_

```ts
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey)
```

Provides the agent key arbitrary runtime value.

### [`agentKeyString`](./test-fixtures.ts#L146)

_Function_

```ts
export const agentKeyString = (seed: number): string
```

Provides the agent key string runtime value.

**Returns:** The agent key string result.

### [`agentKeyStringArbitrary`](./test-fixtures.ts#L126)

_Variable_

```ts
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`)
```

Provides the agent key string arbitrary runtime value.

### [`agentName`](./test-fixtures.ts#L98)

_Function_

```ts
export const agentName = (
  value: string,
): Schema.Schema.Type<typeof agentNameSchema>
```

Validates and decodes agent name values.

**Returns:** The agent name result.

### [`AgentRegistrationError`](./test-fixtures.ts#L188)

_Class_

```ts
export class AgentRegistrationError extends Data.TaggedError(
  "TestingAgentRegistrationError",
)<{
  readonly baseUrl: string;
  readonly agentName: string;
  readonly status: number;
  readonly body: string;
}> {}
```

HTTP registration failed (network, non-2xx, malformed response).

### [`connectionId`](./test-fixtures.ts#L154)

_Variable_

```ts
export const connectionId = decodeConnectionId
```

Provides the connection id runtime value.

### [`conversationId`](./test-fixtures.ts#L107)

_Function_

```ts
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof conversationIdSchema>
```

Validates and decodes conversation id values.

**Returns:** The conversation id result.

### [`messageId`](./test-fixtures.ts#L116)

_Function_

```ts
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema>
```

Validates and decodes message id values.

**Returns:** The message id result.

### [`redactedAgentKey`](./test-fixtures.ts#L136)

_Function_

```ts
export const redactedAgentKey = (value: string): AgentKey
```

Validates and decodes redacted agent key values.

**Returns:** The redacted agent key result.

### [`registerTestAgent`](./test-fixtures.ts#L278)

_Function_

```ts
export function registerTestAgent(
  opts: RegisterTestAgentOptions,
): Effect.Effect<TestAgent, AgentRegistrationError>
```

Registers test agent.

**Returns:** The register test agent result.

### [`TestAgent`](./test-fixtures.ts#L164)

_Interface_

```ts
export interface TestAgent {
  readonly agentId: Schema.Schema.Type<typeof agentIdSchema>;
  readonly apiKey: AgentKey;
  readonly name: string;
}
```

Describes test agent.

### [`userId`](./test-fixtures.ts#L80)

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
