# protocol/testing/conformance/_shared/driver

_`packages/protocol/src/testing/conformance/_shared/driver`_

## Purpose

Lifecycle-backed conformance client barrel.

## Public surface

### [`AgentTestClient`](./test-client.ts#L93)

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

### [`AgentTestClientConfig`](./test-client.ts#L58)

_Interface_

```ts
export interface AgentTestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: AgentKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}
```

### [`AppTestClient`](./test-client.ts#L101)

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

### [`AppTestClientConfig`](./test-client.ts#L65)

_Interface_

```ts
export interface AppTestClientConfig {
  readonly serverUrl: string;
  readonly appKey: AppKey;
  readonly defaultTimeoutMs: number;
  readonly autoConnect?: boolean;
}
```

### [`CloseableAgentTestClient`](./test-client.ts#L123)

_Interface_

```ts
export interface CloseableAgentTestClient extends AgentTestClient {
  readonly close: Effect.Effect<void, never>;
}
```

### [`CloseableAppTestClient`](./test-client.ts#L127)

_Interface_

```ts
export interface CloseableAppTestClient extends AppTestClient {
  readonly close: Effect.Effect<void, never>;
}
```

### [`makeAgentTestClient`](./test-client.ts#L162)

_Function_

```ts
export function makeAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<AgentTestClient, SendRpcError, Scope.Scope>
```

### [`makeAppTestClient`](./test-client.ts#L180)

_Function_

```ts
export function makeAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<AppTestClient, SendRpcError, Scope.Scope>
```

### [`makeCloseableAgentTestClient`](./test-client.ts#L172)

_Function_

```ts
export function makeCloseableAgentTestClient(
  config: AgentTestClientConfig,
): Effect.Effect<CloseableAgentTestClient, SendRpcError>
```

### [`makeCloseableAppTestClient`](./test-client.ts#L190)

_Function_

```ts
export function makeCloseableAppTestClient(
  config: AppTestClientConfig,
): Effect.Effect<CloseableAppTestClient, SendRpcError>
```

### [`NotificationClient`](./test-client.ts#L78)

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

### [`ServerRequestWaitError`](./test-client.ts#L131)

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

### [`ServerRpcContext`](./test-client.ts#L143)

_Interface_

```ts
export interface ServerRpcContext {
  readonly requestId: string;
  readonly definition: ServerRpcDefinition;
}
```

### [`ServerRpcDefinition`](./test-client.ts#L139)

_TypeAlias_

```ts
export type ServerRpcDefinition = AnyAppCallbackRpcDefinition;
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
```

### [`ServerRpcParams`](./test-client.ts#L140)

_TypeAlias_

```ts
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
```

### [`ServerRpcResult`](./test-client.ts#L141)

_TypeAlias_

```ts
export type ServerRpcResult<D extends ServerRpcDefinition> = ResultOf<D>;
```

## Files

- `test-client.ts`
