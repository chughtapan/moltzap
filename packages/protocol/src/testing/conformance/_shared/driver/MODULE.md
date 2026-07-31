# protocol/testing/conformance/_shared/driver

_`packages/protocol/src/testing/conformance/_shared/driver`_

## Purpose

Lifecycle-backed conformance client barrel.

## Public surface

### [`AgentTestClient`](./test-client.ts#L97)

_Interface_

```ts
export interface AgentTestClient extends NotificationClient {
  readonly sendRpc: <D extends AnyAgentCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ClientDefinitionSuccess<D>, SendRpcError>;
}
```

Describes agent test client.

### [`AgentTestClientConfig`](./test-client.ts#L59)

_Interface_

```ts
export interface AgentTestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}
```

Describes agent test client config.

### [`AppTestClient`](./test-client.ts#L106)

_Interface_

```ts
export interface AppTestClient extends NotificationClient {
  readonly sendRpc: <D extends AnyAppCallableRpcDefinition>(
    definition: D,
    params: ClientDefinitionPayload<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ClientDefinitionSuccess<D>, SendRpcError>;

  readonly onAppCallback: <D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, DomainErrorsOf<D>>,
  ) => Effect.Effect<void>;

  readonly awaitServerRequest: <D extends ServerRpcDefinition>(
    definition: D,
    predicate?: (params: ServerRpcParams<D>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError>;
}
```

Describes app test client.

### [`AppTestClientConfig`](./test-client.ts#L67)

_Interface_

```ts
export interface AppTestClientConfig {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}
```

Describes app test client config.

### [`CloseableAgentTestClient`](./test-client.ts#L129)

_Interface_

```ts
export interface CloseableAgentTestClient extends AgentTestClient {
  readonly close: Effect.Effect<void>;
}
```

Describes closeable agent test client.

### [`CloseableAppTestClient`](./test-client.ts#L134)

_Interface_

```ts
export interface CloseableAppTestClient extends AppTestClient {
  readonly close: Effect.Effect<void>;
}
```

Describes closeable app test client.

### [`makeAgentTestClient`](./test-client.ts#L179)

_Function_

```ts
export function makeAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<AgentTestClient, SendRpcError, Scope.Scope>
```

Creates agent test client.

**Returns:** The created agent test client.

### [`makeAppTestClient`](./test-client.ts#L207)

_Function_

```ts
export function makeAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<AppTestClient, SendRpcError, Scope.Scope>
```

Creates app test client.

**Returns:** The created app test client.

### [`makeCloseableAgentTestClient`](./test-client.ts#L194)

_Function_

```ts
export function makeCloseableAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<CloseableAgentTestClient, SendRpcError>
```

Creates closeable agent test client.

**Returns:** The created closeable agent test client.

### [`makeCloseableAppTestClient`](./test-client.ts#L222)

_Function_

```ts
export function makeCloseableAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<CloseableAppTestClient, SendRpcError>
```

Creates closeable app test client.

**Returns:** The created closeable app test client.

### [`NotificationClient`](./test-client.ts#L81)

_Interface_

```ts
export interface NotificationClient {
  readonly subscribe: <D extends AnyNotificationDefinition>(
    definition: D,
  ) => Stream.Stream<NotificationDelivery<D>, TransportClosedError>;

  readonly subscribeAll: (
    refinement?: (
      notification: NotificationDelivery<AnyNotificationDefinition>,
    ) => boolean,
  ) => Stream.Stream<
    NotificationDelivery<AnyNotificationDefinition>,
    TransportClosedError
  >;
}
```

Describes notification client.

### [`ServerRequestWaitError`](./test-client.ts#L139)

_Class_

```ts
export class ServerRequestWaitError extends Data.TaggedError(
  "TestingServerRequestWaitError",
)<{
  readonly message: string;
  readonly definition: ServerRpcDefinition;
  readonly reason: "timeout";
}> {}
```

Reports server request wait failures.

### [`ServerRpcContext`](./test-client.ts#L155)

_Interface_

```ts
export interface ServerRpcContext {
  readonly requestId: string;
  readonly definition: ServerRpcDefinition;
}
```

Carries context for server rpc.

### [`ServerRpcDefinition`](./test-client.ts#L148)

_TypeAlias_

```ts
export type ServerRpcDefinition = AnyAppCallbackRpcDefinition;
```

Represents server rpc definition values.

### [`ServerRpcParams`](./test-client.ts#L150)

_TypeAlias_

```ts
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
```

Represents server rpc params values.

### [`ServerRpcResult`](./test-client.ts#L152)

_TypeAlias_

```ts
export type ServerRpcResult<D extends ServerRpcDefinition> = ResultOf<D>;
```

Represents the result of server rpc.

## Files

- `test-client.ts`
