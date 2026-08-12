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

### [`RealServerAcquireError`](./errors.ts#L47)

_Class_

```ts
export class RealServerAcquireError extends Data.TaggedError(
  "TestingRealServerAcquireError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}
```

Consumer-supplied real-server factory threw or returned an unusable handle.

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

### [`RpcResponseError`](./errors.ts#L36)

_Class_

```ts
export class RpcResponseError extends Data.TaggedError(
  "TestingRpcResponseError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly tag: string;
  readonly message: string;
  readonly data?: unknown;
}> {}
```

Server returned a typed error for a request.

### [`RpcTimeoutError`](./errors.ts#L27)

_Class_

```ts
export class RpcTimeoutError extends Data.TaggedError(
  "TestingRpcTimeoutError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly timeoutMs: number;
}> {}
```

Wall-clock deadline for a request expired before a response.

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

### [`TestingError`](./errors.ts#L60)

_TypeAlias_

```ts
export type TestingError =
  | TransportClosedError
  | TransportIoError
  | RpcTimeoutError
  | RpcResponseError
  | RealServerAcquireError;
```

Represents testing error conditions.

### [`TransportClosedError`](./errors.ts#L10)

_Class_

```ts
export class TransportClosedError extends Data.TaggedError(
  "TestingTransportClosedError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly code: number;
  readonly reason: string;
}> {}
```

Peer closed the underlying WS before a response arrived.

### [`TransportIoError`](./errors.ts#L19)

_Class_

```ts
export class TransportIoError extends Data.TaggedError(
  "TestingTransportIoError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly cause: unknown;
}> {}
```

Underlying transport raised (socket error, DNS, TLS, etc.).

### [`userId`](./test-fixtures.ts#L80)

_Function_

```ts
export const userId = (
  value: string,
): Schema.Schema.Type<typeof userIdSchema>
```

Validates and decodes user id values.

**Returns:** The user id result.

### [`waitForValue`](./wait.ts#L46)

_Function_

```ts
export const waitForValue = <A, E = never, R = never>(
  probe: Effect.Effect<A | undefined, E, R>,
  options?: { readonly pollMillis?: number },
): Effect.Effect<A, E, R>
```

Poll `probe` until it returns a defined value, then return it.

**Returns:** The wait for value result.

### [`waitUntil`](./wait.ts#L28)

_Function_

```ts
export const waitUntil = (
  predicate: () => boolean,
  options?: { readonly pollMillis?: number },
): Effect.Effect<void>
```

Poll `predicate` until it returns true.

**Returns:** The wait until result.

### [`WIRE_ERROR_TAG`](./wire-error-tags.ts#L9)

_Variable_

```ts
export const WIRE_ERROR_TAG =
```

## Files

- `errors.ts`
- `test-fixtures.ts`
- `wait.ts`
- `wire-error-tags.ts`
