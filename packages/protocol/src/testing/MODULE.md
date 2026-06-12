# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — test fixtures, typed lifecycle clients,
arbitrary derivation, and Toxiproxy adversity helpers.

## Public surface

### [`agentId`](./test-fixtures.ts#L78)

_Function_

```ts
export const agentId = (value: string): Schema.Schema.Type<typeof AgentId>
```

### [`agentKeyArbitrary`](./test-fixtures.ts#L112)

_Variable_

```ts
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey)
```

### [`agentKeyString`](./test-fixtures.ts#L114)

_Function_

```ts
export const agentKeyString = (seed: number): string
```

### [`agentKeyStringArbitrary`](./test-fixtures.ts#L107)

_Variable_

```ts
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`)
```

### [`AgentRegistrationError`](./test-fixtures.ts#L154)

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

### [`appId`](./test-fixtures.ts#L96)

_Function_

```ts
export const appId = (value: string): Schema.Schema.Type<typeof AppId>
```

### [`connectionId`](./test-fixtures.ts#L121)

_Variable_

```ts
export const connectionId = decodeConnectionId
```

### [`contactId`](./test-fixtures.ts#L80)

_Function_

```ts
export const contactId = (
  value: string,
): Schema.Schema.Type<typeof ContactId>
```

### [`conversationId`](./test-fixtures.ts#L84)

_Function_

```ts
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof ConversationId>
```

### [`leaseId`](./test-fixtures.ts#L94)

_Function_

```ts
export const leaseId = (value: string): Schema.Schema.Type<typeof LeaseId>
```

### [`makeTestAgentClient`](./lifecycle.ts#L232)

_Function_

```ts
export function makeTestAgentClient(
  agentId: AgentId,
  options: AgentClientOptions,
): Effect.Effect<TestAgentClient, unknown>
```

### [`makeTestAppClient`](./lifecycle.ts#L256)

_Function_

```ts
export function makeTestAppClient(
  appId: AppId,
  options: AppClientOptions,
): Effect.Effect<TestAppClient, unknown>
```

### [`messageId`](./test-fixtures.ts#L88)

_Function_

```ts
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof MessageId>
```

### [`mintTestAppCredential`](./test-fixtures.ts#L300)

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

### [`RealServerAcquireError`](./errors.ts#L44)

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

### [`redactedAgentKey`](./test-fixtures.ts#L98)

_Function_

```ts
export const redactedAgentKey = (value: string): AgentKey
```

### [`redactedAppKey`](./test-fixtures.ts#L100)

_Function_

```ts
export const redactedAppKey = (value: string): AppKey
```

### [`registerTestAgent`](./test-fixtures.ts#L347)

_Function_

```ts
export function registerTestAgent(
  opts: RegisterTestAgentOptions,
): Effect.Effect<TestAgent, AgentRegistrationError>
```

### [`RpcResponseError`](./errors.ts#L33)

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

### [`RpcTimeoutError`](./errors.ts#L24)

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

### [`taskId`](./test-fixtures.ts#L92)

_Function_

```ts
export const taskId = (value: string): Schema.Schema.Type<typeof TaskId>
```

### [`TestAgent`](./test-fixtures.ts#L130)

_Interface_

```ts
export interface TestAgent {
  readonly agentId: Schema.Schema.Type<typeof AgentId>;
  readonly apiKey: AgentKey;
  readonly name: string;
}
```

### [`TestAgentClient`](./lifecycle.ts#L49)

_Interface_

```ts
export interface TestAgentClient {
  readonly principal: "agent";
  readonly agentId?: AgentId;
  close(): Effect.Effect<void, never>;
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

### [`TestAppClient`](./lifecycle.ts#L77)

_Interface_

```ts
export interface TestAppClient {
  readonly principal: "app";
  readonly appId?: AppId;
  close(): Effect.Effect<void, never>;
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

### [`TestAppCredential`](./test-fixtures.ts#L242)

_Interface_

```ts
export interface TestAppCredential {
  readonly appId: Schema.Schema.Type<typeof AppId>;
  readonly appKey: AppKey;
}
```

Server-minted app principal credentials.

### [`TestAppHttpRegistrationError`](./test-fixtures.ts#L266)

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

### [`TestingError`](./errors.ts#L56)

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

### [`TestServer`](./lifecycle.ts#L43)

_Interface_

```ts
export interface TestServer {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly close: Effect.Effect<void, unknown>;
}
```

### [`TransportClosedError`](./errors.ts#L7)

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

### [`TransportIoError`](./errors.ts#L16)

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

### [`userId`](./test-fixtures.ts#L76)

_Function_

```ts
export const userId = (value: string): Schema.Schema.Type<typeof UserId>
```

### [`waitForValue`](./wait.ts#L30)

_Function_

```ts
export const waitForValue = <A, E = never, R = never>(
  probe: Effect.Effect<A | undefined, E, R>,
  options?: { readonly pollMillis?: number },
): Effect.Effect<A, E, R>
```

Poll `probe` until it returns a defined value, then return it.

### [`waitUntil`](./wait.ts#L18)

_Function_

```ts
export const waitUntil = (
  predicate: () => boolean,
  options?: { readonly pollMillis?: number },
): Effect.Effect<void>
```

Poll `predicate` until it returns true.

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
