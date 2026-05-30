# protocol/testing/conformance/_shared/driver

_`packages/protocol/src/testing/conformance/_shared/driver`_

## Purpose

Wire-driver harness barrel for the `_shared/driver/` sub-folder.

The `driver/` folder contains test-time JSON-RPC wire harnesses.

These harnesses act as a counterparty for property tests.

The folder currently contains `test-client.ts` and `test-server.ts`.
Future wire-driver helpers belong here. Other helpers belong elsewhere.

Re-exporting keeps external consumers on the public testing entrypoint.

## Public surface

### [`CloseableTestClient`](./test-client.ts#L284)

_Interface_

```ts
export interface CloseableTestClient extends TestClient {
  readonly close: Effect.Effect<void, never>;
}
```

Handle surface. Scoped: acquiring the handle opens the WS; releasing the
scope closes it. All methods return Effects so property code can compose
them inside `Effect.forEach` / `fc.asyncProperty`.

### [`makeCloseableTestClient`](./test-client.ts#L1169)

_Function_

```ts
export function makeCloseableTestClient(
  config: TestClientConfig,
): Effect.Effect<
  CloseableTestClient,
  TransportIoError | TransportClosedError | RpcResponseError
>
```

### [`makeTestClient`](./test-client.ts#L1156)

_Function_

```ts
export function makeTestClient(
  config: TestClientConfig,
): Effect.Effect<
  TestClient,
  TransportIoError | TransportClosedError | RpcResponseError,
  Scope.Scope
>
```

Open a real WS connection to `config.serverUrl`, complete the `connect`
handshake, and yield a `TestClient`. The surrounding `Scope` owns the
socket; releasing it closes the WS and drains captures.

### [`makeTestServer`](./test-server.ts#L186)

_Function_

```ts
export function makeTestServer(
  config: TestServerConfig,
): Effect.Effect<TestServer, TransportIoError, Scope.Scope>
```

Bind an `@effect/platform` WebSocket server. The surrounding `Scope` owns
the listener; releasing it closes every open connection, drains captures,
and awaits port release.

### [`makeTestSubscriberRegistry`](./test-subscribers.ts#L353)

_Function_

```ts
export function makeTestSubscriberRegistry(): Effect.Effect<
  TestSubscriberRegistry,
  never
>
```

Construct an empty registry. Called once from
`acquireTestClientRuntime` after the socket is acquired so its
`Effect.addFinalizer(closeAll)` runs LIFO BEFORE the socket reader
finalizer — consumers see `emit.fail(TransportClosedError)` before
the transport tears down.

### [`ServerRequestWaitError`](./test-client.ts#L256)

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

### [`ServerRpcContext`](./test-client.ts#L279)

_Interface_

```ts
export interface ServerRpcContext {
  readonly requestId: JsonRpcId;
  readonly definition: ServerRpcDefinition;
}
```

### [`ServerRpcDefinition`](./test-client.ts#L267)

_TypeAlias_

```ts
export type ServerRpcDefinition = AnyTaskCallbackRpcDefinition;

/**
 * Inbound params type for an app-callback method.
 */
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
```

Descriptor constraint for app-callback RPC test surface.

### [`ServerRpcParams`](./test-client.ts#L272)

_TypeAlias_

```ts
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;
```

Inbound params type for an app-callback method.

### [`ServerRpcResult`](./test-client.ts#L277)

_TypeAlias_

```ts
export type ServerRpcResult<D extends ServerRpcDefinition> = ResultOf<D>;
```

Outbound result type for an app-callback method handler.

### [`subscribe`](./test-subscribers.ts#L389)

_Function_

```ts
export function subscribe<D extends AnyNotificationDefinition>(
  registry: TestSubscriberRegistry,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, TransportClosedError>
```

Typed-payload subscribe. Returns a `Stream` whose error channel is
`TransportClosedError` and requirement set is `never`. The Stream
value is pure; materialisation installs the registry callbacks.

The type-guard overload narrows the Stream's payload to
`DecodedNotification<D, R>`.

Lifecycle parity with production (`packages/client/src/notification/stream.ts`):
  - Construction is pure (no I/O).
  - Materialisation runs `registry.register` synchronously via
    `Effect.runSync` (Ref-only Effect; never yields).
  - Consumer pulls suspend inside `Stream.async`'s internal queue
    until dispatch fires `emit.single`.
  - Terminal close fires `emit.fail(TransportClosedError)` from the
    registry's `closeAll`.
  - Cancellation finalizer runs `handle.unregister` via
    `Effect.suspend` so future yielded effects inside `unregister`
    stay deferred (matches production P3 fix #613).

### [`subscribeAll`](./test-subscribers.ts#L430)

_Function_

```ts
export function subscribeAll(
  registry: TestSubscriberRegistry,
  refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  TransportClosedError
>
```

Broad-union subscribe. Returns a `Stream` of every inbound
notification regardless of definition. Used by conformance helpers
that need to filter on params-shaped predicates not expressible at
the definition level (e.g. presence/changed by agentId+status).

### [`TestClient`](./test-client.ts#L141)

_Interface_

```ts
export interface TestClient {
  readonly sendRpc: <D extends AnyServerRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ResultOf<D>, SendRpcError>;

  readonly sendMalformed: <D extends AnyServerRpcDefinition>(opts: {
    readonly baseDefinition: D;
    readonly baseParams: ParamsOf<D>;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<
    RpcResponseError | null,
    TransportClosedError | TransportIoError | FrameSchemaError
  >;

  readonly sendResponseFrame: (
    frame: ResponseFrame,
  ) => Effect.Effect<void, TransportClosedError | TransportIoError>;

  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;

  /**
   * Typed-payload subscribe (Spec B parity — #645). Returns a Stream of
   * `DecodedNotification<D>` whose error channel is `TransportClosedError`
   * and requirement set is `never`. Optional `refinement` is a typed
   * predicate over the definition's params; the type-guard overload
   * narrows the Stream's payload to `DecodedNotification<D, R>`.
   *
   * Lifecycle: construction is pure (no I/O, no scope); first pull
   * suspends inside `Stream.async` until dispatch fires `emit.single`;
   * terminal `TestClient.close` fires `emit.fail(TransportClosedError)`
   * via the registry's `closeAll`.
   */
  readonly subscribe: {
    <D extends AnyNotificationDefinition>(
      definition: D,
      refinement?: (params: NotificationParamsOf<D>) => boolean,
    ): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
    <D extends AnyNotificationDefinition, R extends NotificationParamsOf<D>>(
      definition: D,
      refinement: (params: NotificationParamsOf<D>) => params is R,
    ): Stream.Stream<DecodedNotification<D, R>, TransportClosedError>;
  };

  /**
   * Broad-union subscribe (Spec B parity — #645). Returns a Stream of
   * every inbound notification regardless of definition. Used by
   * conformance helpers that need to filter on params-shaped predicates
   * (e.g. presence/changed by agentId+status). Payload narrowing is
   * intentionally lost; callers wanting typed payloads use `subscribe`.
   */
  readonly subscribeAll: (
    refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ) => Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
  >;

  /**
   * Register a handler for an app-callback RPC (test-driver-local;
   * distinct from the production `MoltZapAgentClient`'s static handler
   * table, which is immutable per Spec F I1).
   *
   * When `handleInbound` sees a request frame whose method matches,
   * the handler runs and its outcome is encoded as the JSON-RPC
   * response:
   *   - `Effect.succeed(value)` → `{ result: value }`
   *   - `Effect.fail(err: RpcResponseError)` → `{ error: { code, message, data? } }`
   *   - defects collapse to a generic `-32603 InternalError` reply so the
   *     server's `Deferred.await` cannot hang on a crashing handler.
   *
   * Re-registration replaces the prior handler (later wins) — mirrors
   * `HashMap.set`. The TestClient does NOT raise on duplicates; tests
   * routinely swap behaviour mid-scenario. This is the deliberate
   * driver-side relaxation that lets conformance tests exercise
   * scenarios the static production table cannot express.
   *
   * `M` constrains to the registered app-callback method names and
   * `params`/`result` bind to the matching descriptor.
   */
  readonly onAppCallback: <D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ) => Effect.Effect<void>;

  /**
   * Park until the server sends an app-callback request for `method`. The handler
   * registered via {@link onAppCallback} (if any) still runs and replies;
   * `awaitServerRequest` is an OBSERVATION primitive — it lets a test
   * assert the request payload before the response goes back without
   * stealing the dispatch.
   *
   * `predicate` narrows to the first request whose params satisfy it.
   * Multiple awaiters per method form a FIFO queue (registration order).
   *
   * `timeoutMs` defaults to 5_000; callers wanting to drive timing
   * themselves can pass a generous value here and gate the returned
   * Effect with `Effect.timeout` at the call site (architect plan §3.6
   * "Effect.timeout at call site, not schema cap").
   */
  readonly awaitServerRequest: <D extends ServerRpcDefinition>(
    definition: D,
    predicate?: (params: ServerRpcParams<D>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError>;
}
```

Handle surface. Scoped: acquiring the handle opens the WS; releasing the
scope closes it. All methods return Effects so property code can compose
them inside `Effect.forEach` / `fc.asyncProperty`.

### [`TestClient`](./test-client.ts#L141)

_Variable_

```ts
export interface TestClient
```

Context tag so property code can `Effect.serviceWith(TestClient, …)`.

### [`TestClientConfig`](./test-client.ts#L100)

_Interface_

```ts
export interface TestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly agentId: Schema.Schema.Type<typeof AgentId>;
  readonly defaultTimeoutMs: number;
  /** Soft cap on captured frames before the ring buffer drops oldest. */
  readonly captureCapacity: number;

  /**
   * D #705 CP5/CP7 — when set, the `network/connect` handshake uses the
   * app-principal `appKey` arm instead of the agent `agentKey` arm, so the
   * connection authenticates as an `AppConnection`. Used by app-arm
   * integration tests (e.g. `app-session-scoping`) that drive the TM as a
   * first-class app principal rather than the dead #673 agent-AppsRegisters
   * model. Mutually exclusive with the agent path at the wire (the Connect
   * params union is disjoint).
   */
  readonly appKey?: string;

  /**
   * When `true`, send the `network/connect` handshake automatically after the
   * WS upgrade. Defaults to `true`.
   */
  readonly autoConnect?: boolean;
  /** Quiescence window (ms) for `sendMalformed` to wait for a response. */
  readonly malformedQuiescenceMs?: number;
}
```

Options for connecting a TestClient. `serverUrl` is the `ws://…` URL of
the real server; `agentKey` + `agentId` are for the `connect` handshake.
`defaultTimeoutMs` bounds each `sendRpc` unless overridden per call.

### [`TestServer`](./test-server.ts#L91)

_Interface_

```ts
export interface TestServer {
  readonly wsUrl: string;
  readonly accept: Effect.Effect<TestServerConnection, TransportIoError>;
  readonly connections: Effect.Effect<ReadonlyArray<TestServerConnection>>;
  readonly allInbound: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
}
```

### [`TestServer`](./test-server.ts#L91)

_Variable_

```ts
export interface TestServer
```

### [`TestServerConfig`](./test-server.ts#L57)

_Interface_

```ts
export interface TestServerConfig {
  /** If 0, bind to an ephemeral port. */
  readonly port: number;
  /** Host string bound by the HTTP server; default `"127.0.0.1"`. */
  readonly host: string;
  readonly captureCapacity: number;
}
```

### [`TestServerConnection`](./test-server.ts#L70)

_Interface_

```ts
export interface TestServerConnection {
  readonly connectionId: string;
  readonly remoteAddr: string;
  readonly inbound: CaptureBuffer;
  readonly emitNotification: (
    notification: NotificationFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitResponse: (
    response: ResponseFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitMalformed: (opts: {
    readonly baseNotification: NotificationFrame;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<void, TransportIoError>;
  readonly close: (opts: {
    readonly code: number;
    readonly reason: string;
  }) => Effect.Effect<void, TransportClosedError>;
}
```

A single live client connection accepted by TestServer. Identity is by
`connectionId` (monotonic), not by any agent-level claim — TestServer is
below the identity layer.

### [`TestSubscriberRegistry`](./test-subscribers.ts#L114)

_Interface_

```ts
export interface TestSubscriberRegistry {
  readonly register: <D extends AnyNotificationDefinition>(
    definition: D,
    refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
    callbacks: {
      readonly onFrame: (
        frame: DecodedNotification<D>,
      ) => Effect.Effect<void, never>;
      readonly onClose: SubscriberCloseCallback;
    },
  ) => Effect.Effect<TestSubscriptionHandle, never>;

  readonly registerAll: (
    refinement:
      | ((
          notification: DecodedNotification<AnyNotificationDefinition>,
        ) => boolean)
      | undefined,
    callbacks: {
      readonly onFrame: SubscriberFrameCallback;
      readonly onClose: SubscriberCloseCallback;
    },
  ) => Effect.Effect<TestSubscriptionHandle, never>;

  readonly dispatch: (
    frame: DecodedNotification<AnyNotificationDefinition>,
  ) => Effect.Effect<void, never>;

  readonly closeAll: Effect.Effect<void, never>;
}
```

Subscriber registry. One instance per `TestClientRuntime`.

- `register<D>` accepts typed `onFrame` / `onClose` callbacks for the
  specific definition `D`; storage erases callbacks to the union shape.
- `registerAll` accepts callbacks against the broad-union
  `DecodedNotification<AnyNotificationDefinition>` shape; storage
  parks a `definition: null` sentinel record in the same list.
- `dispatch` snapshots `subsRef` at iteration start; per-definition
  subs match on `sub.definition === frame.definition`, broad-union
  subs match unconditionally; optional `refinement` runs after the
  definition gate.
- `closeAll` invokes each live sub's onClose with a
  `TransportClosedError` before clearing `subsRef`. Idempotent.

### [`TestSubscriptionHandle`](./test-subscribers.ts#L94)

_Interface_

```ts
export interface TestSubscriptionHandle {
  readonly id: string;
  readonly unregister: Effect.Effect<void, never>;
}
```

Handle returned by `register` / `registerAll`. `unregister` is
`Effect<void, never>`: idempotent and total. The `Stream.async`
cancellation finalizer invokes it; a duplicate call after
`closeAll` is a no-op.

## Files

- `test-client.ts`
- `test-server.ts`
- `test-subscribers.ts`
