# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — test fixtures, typed lifecycle clients,
arbitrary derivation, and Toxiproxy adversity helpers.

## Public surface

### [`agentId`](./test-fixtures.ts#L96)

_Function_

```ts
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema>
```

Validates and decodes agent id values.

**Returns:** The agent id result.

### [`agentKeyArbitrary`](./test-fixtures.ts#L187)

_Variable_

```ts
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey)
```

Provides the agent key arbitrary runtime value.

### [`agentKeyString`](./test-fixtures.ts#L194)

_Function_

```ts
export const agentKeyString = (seed: number): string
```

Provides the agent key string runtime value.

**Returns:** The agent key string result.

### [`agentKeyStringArbitrary`](./test-fixtures.ts#L181)

_Variable_

```ts
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`)
```

Provides the agent key string arbitrary runtime value.

### [`agentName`](./test-fixtures.ts#L105)

_Function_

```ts
export const agentName = (
  value: string,
): Schema.Schema.Type<typeof agentNameSchema>
```

Validates and decodes agent name values.

**Returns:** The agent name result.

### [`AgentRegistrationError`](./test-fixtures.ts#L236)

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

### [`appId`](./test-fixtures.ts#L159)

_Function_

```ts
export const appId = (value: string): Schema.Schema.Type<typeof appIdSchema>
```

Validates and decodes app id values.

**Returns:** The app id result.

### [`connectionId`](./test-fixtures.ts#L202)

_Variable_

```ts
export const connectionId = decodeConnectionId
```

Provides the connection id runtime value.

### [`contactId`](./test-fixtures.ts#L114)

_Function_

```ts
export const contactId = (
  value: string,
): Schema.Schema.Type<typeof contactIdSchema>
```

Validates and decodes contact id values.

**Returns:** The contact id result.

### [`conversationId`](./test-fixtures.ts#L123)

_Function_

```ts
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof conversationIdSchema>
```

Validates and decodes conversation id values.

**Returns:** The conversation id result.

### [`leaseId`](./test-fixtures.ts#L150)

_Function_

```ts
export const leaseId = (
  value: string,
): Schema.Schema.Type<typeof leaseIdSchema>
```

Validates and decodes lease id values.

**Returns:** The lease id result.

### [`makeTestAgentClient`](./lifecycle.ts#L245)

_Function_

```ts
export function makeTestAgentClient(
  agentId: AgentId,
  options: AgentClientOptions,
): Effect.Effect<TestAgentClient, unknown>
```

Creates test agent client.

**Returns:** The created test agent client.

### [`makeTestAppClient`](./lifecycle.ts#L275)

_Function_

```ts
export function makeTestAppClient(
  appId: AppId,
  options: AppClientOptions,
): Effect.Effect<TestAppClient, unknown>
```

Creates test app client.

**Returns:** The created test app client.

### [`messageId`](./test-fixtures.ts#L132)

_Function_

```ts
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema>
```

Validates and decodes message id values.

**Returns:** The message id result.

### [`mintTestAppCredential`](./test-fixtures.ts#L390)

_Function_

```ts
export function mintTestAppCredential(
  opts: RegisterTestAppOptions,
): Effect.Effect<TestAppCredential, TestAppHttpRegistrationError>
```

Register an app manifest against the real server's HTTP endpoint and
return the server-minted `{ appId, appKey }` (the `appId` is
`gen_random_uuid()`, NOT `manifest.appId`). The App-principal sibling of
registerTestAgent; the `appKey` is handed to a `TestClient` whose
`appKey` Connect arm binds an `AppConnection` through the implicit
moderator-endpoint registration path.

**Returns:** The mint test app credential result.

### [`RealServerAcquireError`](./errors.ts#L45)

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

### [`redactedAgentKey`](./test-fixtures.ts#L166)

_Function_

```ts
export const redactedAgentKey = (value: string): AgentKey
```

Validates and decodes redacted agent key values.

**Returns:** The redacted agent key result.

### [`redactedAppKey`](./test-fixtures.ts#L173)

_Function_

```ts
export const redactedAppKey = (value: string): AppKey
```

Validates and decodes redacted app key values.

**Returns:** The redacted app key result.

### [`registerTestAgent`](./test-fixtures.ts#L442)

_Function_

```ts
export function registerTestAgent(
  opts: RegisterTestAgentOptions,
): Effect.Effect<TestAgent, AgentRegistrationError>
```

Registers test agent.

**Returns:** The register test agent result.

### [`RpcResponseError`](./errors.ts#L34)

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

### [`RpcTimeoutError`](./errors.ts#L25)

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

### [`taskId`](./test-fixtures.ts#L141)

_Function_

```ts
export const taskId = (
  value: string,
): Schema.Schema.Type<typeof taskIdSchema>
```

Validates and decodes task id values.

**Returns:** The task id result.

### [`TestAgent`](./test-fixtures.ts#L212)

_Interface_

```ts
export interface TestAgent {
  readonly agentId: Schema.Schema.Type<typeof agentIdSchema>;
  readonly apiKey: AgentKey;
  readonly name: string;
}
```

Describes test agent.

### [`TestAgentClient`](./lifecycle.ts#L53)

_Interface_

```ts
export interface TestAgentClient {
  readonly principal: "agent";
  readonly agentId?: AgentId;
  close(): Effect.Effect<void>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError>;
  subscribeAll(
    refinement?: (
      delivery: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    NotConnectedError
  >;
  sendRpc<D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>>;
  call<Tag extends AgentCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AgentCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, AgentRpcError<Tag>>;
}
```

Describes test agent client.

### [`TestAppClient`](./lifecycle.ts#L82)

_Interface_

```ts
export interface TestAppClient {
  readonly principal: "app";
  readonly appId?: AppId;
  close(): Effect.Effect<void>;
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<NotificationParamsOf<D>, NotConnectedError>;
  subscribeAll(
    refinement?: (
      delivery: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    NotConnectedError
  >;
  sendRpc<D extends AnyAppCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ClientDefinitionSuccess<D>, ClientDefinitionError<D>>;
  call<Tag extends AppCallableTag>(
    tag: Tag,
    payload: PayloadForTag<AppCallableRpcs, Tag>,
    opts?: RpcCallOptions,
  ): Effect.Effect<SuccessForTag<AppCallableRpcs, Tag>, AppRpcError<Tag>>;
}
```

Describes test app client.

### [`TestAppCredential`](./test-fixtures.ts#L328)

_Interface_

```ts
export interface TestAppCredential {
  readonly appId: Schema.Schema.Type<typeof appIdSchema>;
  readonly appKey: AppKey;
}
```

Server-minted app principal credentials.

### [`TestAppHttpRegistrationError`](./test-fixtures.ts#L352)

_Class_

```ts
export class TestAppHttpRegistrationError extends Data.TaggedError(
  "TestingAppHttpRegistrationError",
)<{
  readonly baseUrl: string;
  readonly status: number;
  readonly body: string;
}> {}
```

HTTP app registration failed (network, non-2xx, malformed response).

### [`TestingError`](./errors.ts#L58)

_TypeAlias_

```ts
export type TestingError =
  | TransportClosedError
  | TransportIoError
  | RpcTimeoutError
  | RpcResponseError
  | ToxicControlError
  | RealServerAcquireError;
```

Represents testing error conditions.

### [`TestServer`](./lifecycle.ts#L46)

_Interface_

```ts
export interface TestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly close: Effect.Effect<void, unknown>;
}
```

Describes test server.

### [`TransportClosedError`](./errors.ts#L8)

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

### [`TransportIoError`](./errors.ts#L17)

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

### [`userId`](./test-fixtures.ts#L87)

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
- `lifecycle.ts`
- `test-fixtures.ts`
- `wait.ts`
- `wire-error-tags.ts`
