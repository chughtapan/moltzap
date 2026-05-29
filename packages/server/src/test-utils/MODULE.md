# server-core/test-utils

_`packages/server/src/test-utils`_

## Purpose

Shared server-core test utility exports.

## Public surface

### [`AppEndpointHandlers`](./app-endpoint.ts#L49)

_TypeAlias_

```ts
export type AppEndpointHandlers = {
  readonly [D in AnyTaskCallbackRpcDefinition as D["name"]]: AppEndpointHandler<D>;
};
```

Mapped over the closed `AnyTaskCallbackRpcDefinition` union, keyed
by each definition's wire name. Mandates one handler per
task-callback RPC at construction time — adding a new entry to
`taskCallbackMethods` becomes a compile error at every endpoint
construction site.

### [`AwaitNotificationError`](./helpers.ts#L70)

_TypeAlias_

```ts
export type AwaitNotificationError =
  | AwaitNotificationTimeoutError
  | AwaitNotificationClosedError;

/**
 * Stream-based one-shot waiter. Consumes `client.subscribeTo(def)` via
 * `Stream.runHead`, failing with a tagged error on timeout or stream
 * exhaustion. Replaces the deleted `client.waitForNotification(def)` shape
 * at integration-test call sites; preserves the `yield* …` ergonomic but
 * runs entirely on the new `Stream.async`-backed subscription API.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<ServerTestClient, "subscribeTo">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<
  DecodedNotification<D>,
  AwaitNotificationError | TransportClosedError
> {
  return client.subscribeTo(definition).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new AwaitNotificationTimeoutError({
          definition: definition.name,
          durationMs: timeoutMs,
        }),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new AwaitNotificationClosedError({
              definition: definition.name,
            }),
          ),
        onSome: (notification) => Effect.succeed(notification),
      }),
    ),
  );
}
```

### [`awaitOneNotification`](./helpers.ts#L81)

_Function_

```ts
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<ServerTestClient, "subscribeTo">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<
  DecodedNotification<D>,
  AwaitNotificationError | TransportClosedError
>
```

Stream-based one-shot waiter. Consumes `client.subscribeTo(def)` via
`Stream.runHead`, failing with a tagged error on timeout or stream
exhaustion. Replaces the deleted `client.waitForNotification(def)` shape
at integration-test call sites; preserves the `yield* …` ergonomic but
runs entirely on the new `Stream.async`-backed subscription API.

### [`closeAllClients`](./helpers.ts#L177)

_Function_

```ts
export function closeAllClients(): Effect.Effect<void, never>
```

### [`ConnectedAgent`](./helpers.ts#L113)

_Interface_

```ts
export interface ConnectedAgent {
  client: ServerTestClient;
  agentId: ProtocolAgentId;
  apiKey: string;
  name: string;
}
```

### [`connectTestClient`](./helpers.ts#L275)

_Function_

```ts
export function connectTestClient(opts: {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  autoConnect?: boolean;
}): Effect.Effect<ServerTestClient, Error>
```

### [`CoreSchemaSqlLoadError`](./core-schema-sql.ts#L24)

_TypeAlias_

```ts
export type CoreSchemaSqlLoadError =
  | CoreSchemaSqlAccessError
  | CoreSchemaSqlReadError;

const __dirname = dirname(fileURLToPath(import.meta.url));
```

### [`CoreTestRuntimeServerHandle`](./server.ts#L55)

_Interface_

```ts
export interface CoreTestRuntimeServerHandle {
  awaitAgentReady(
    agentId: string,
    timeoutMs: number,
  ): Effect.Effect<CoreTestReadyOutcome, never, never>;
}
```

### [`CoreTestServer`](./server.ts#L111)

_Interface_

```ts
export interface CoreTestServer {
  baseUrl: string;
  wsUrl: string;
  db: EffectKysely<Database>;
  coreApp: CoreApp;

  /**
   * Pre-wired `RuntimeServerHandle` for runtime-adapter tests. Implements
   * `awaitAgentReady` by polling the live `ConnectionManager` — the same
   * pattern `@moltzap/runtimes`'s `awaitAgentReadyByPolling` exports for
   * downstream in-process consumers. Out-of-process consumers (zapbot's
   * orchestrator) construct their own handle over WebSocket presence.
   */
  runtimeServer: CoreTestRuntimeServerHandle;

  /**
   * The auto-wired `InMemorySpanExporter`, or `null` when the caller
   * supplied a custom `spanProcessor`. Tests that want to inspect OTel
   * spans call `getFinishedSpans()` on this exporter and map them via
   * their own shim (see `runtimes/` for arena's mapping).
   */
  readonly spanExporter: InMemorySpanExporter | null;
}
```

### [`expectRpcFailure`](./rpc-error.ts#L23)

_Function_

```ts
export const expectRpcFailure = <A, R>(
  effect: Effect.Effect<A, RpcTestError, R>,
  expectedCode: number,
): Effect.Effect<RpcResponseError, never, R>
```

Asserts the RPC effect fails with `RpcServerError(code)` and returns the
narrowed error for follow-up assertions. `catchTags` routes by tag name
declaratively so callers never reach for `err._tag`.

### [`getBaseUrl`](./server.ts#L386)

_Function_

```ts
export function getBaseUrl(): string
```

### [`getCoreApp`](./server.ts#L378)

_Function_

```ts
export function getCoreApp(): CoreApp
```

### [`getCoreDb`](./server.ts#L363)

_Function_

```ts
export function getCoreDb(): EffectKysely<Database>
```

### [`getCoreEncryptionEnvelope`](./server.ts#L371)

_Function_

```ts
export function getCoreEncryptionEnvelope(): EnvelopeEncryption
```

### [`getWsUrl`](./server.ts#L391)

_Function_

```ts
export function getWsUrl(): string
```

### [`loadCoreSchemaSql`](./core-schema-sql.ts#L88)

_Function_

```ts
export function loadCoreSchemaSql(): Effect.Effect<
  string,
  CoreSchemaSqlLoadError
>
```

### [`makeFakeService`](./fakes.ts#L42)

_Function_

```ts
export const makeFakeService = <S extends object>(impl: Partial<S>): S
```

Build a typed test double for an interface `S` from a partial implementation.
The cast is intentional: tests typically implement only the methods the
system under test actually calls. Unused methods throw at runtime via the
`Proxy` trap so a missing implementation becomes a clear test failure
instead of `undefined is not a function`.

Because the generic parameter `S` is invariant, TypeScript still enforces
that every method you *do* implement matches the real signature — this is
the compile-time contract-drift insurance. Adding a field to the real
interface does NOT fail compilation (tests are a Partial), but changing an
existing field's signature does.

### [`makeHandlerAppEndpoint`](./app-endpoint.ts#L74)

_Function_

```ts
export function makeHandlerAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly handlers: AppEndpointHandlers;
}): AppEndpoint
```

Build an AppEndpoint whose outbound `originator.call` dispatches to
in-process handlers instead of going over a WebSocket. The endpoint
satisfies the same `{ connId, originator }` shape a wire-registered app's
arm carries so `AppHost`, `AppRegistry`, and `sendRpcToClient` see ONE shape.

  - `originator.call(D, params)` indexes `handlers` by `D.name`. The
    mapped type guarantees every member of `AnyTaskCallbackRpcDefinition`
    has a handler — no runtime "method not found" branch exists.
  - `originator.notify` / `failAllPending` are no-ops.
  - `originator.handle` / `originator.resolve` defect — an in-process
    endpoint never receives inbound frames; a call here is a wiring bug.

### [`makeInertAppEndpoint`](./app-endpoint.ts#L115)

_Function_

```ts
export function makeInertAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly originatorCall?: <D extends AnyTaskCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, RpcCallError>;
}): AppEndpoint
```

Minimal AppEndpoint for tests that only assert the
registration surface (connId keying, unregister-side effects, etc.).
Every dispatch method defects — tests that actually drive
`runMessageAuthorize` / `runDispatchAuthorize` against a declared hook
MUST use makeHandlerAppEndpoint (or a real wire connection via
`acquireConnectionRpcClient`).

Optional `originatorCall` override lets a test mock the outbound
RPC channel (e.g., to simulate a stale-connection `NotConnectedError`
without spinning up a real socket).

### [`makePgliteHarness`](./pglite-harness.ts#L72)

_Function_

```ts
export function makePgliteHarness(): Effect.Effect<
  PgliteHarness,
  PgliteHarnessError
>
```

Spin up a fresh PGlite instance with the core schema loaded.

### [`PGLITE_HOOK_TIMEOUT_MS`](./pglite-harness.ts#L27)

_Variable_

```ts
export const PGLITE_HOOK_TIMEOUT_MS = 30_000
```

Suggested timeout for pglite-backed beforeEach/afterEach hooks.

### [`PgliteHarness`](./pglite-harness.ts#L57)

_Interface_

```ts
export interface PgliteHarness {
  /** Effect-Kysely-wrapped client. Yieldable as Effect via the toolkit. */
  readonly db: EffectKysely<Database>;

  /**
   * Run raw SQL. The harness uses this to load the schema; tests can use it
   * to seed extra rows after `make()` returns.
   */
  readonly exec: (sql: string) => Effect.Effect<unknown, PgliteExecError>;

  /** Tear down the in-memory instance. Call from `afterEach`. */
  readonly close: Effect.Effect<void, PgliteCloseError>;
}
```

### [`PgliteHarnessError`](./pglite-harness.ts#L45)

_TypeAlias_

```ts
export type PgliteHarnessError =
  | CoreSchemaSqlLoadError
  | PgliteCreateError
  | PgliteExecError
  | PgliteCloseError;

const SQL_PREVIEW_MAX_CHARS = 160;

function sqlPreview(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, SQL_PREVIEW_MAX_CHARS);
}
```

### [`postJson`](./helpers.ts#L337)

_Function_

```ts
export function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Effect.Effect<PostJsonResult, PostJsonError>
```

POST `body` as JSON to `${baseUrl}${path}` and resolve with
`{status, json}`. The endpoints under test (`/api/v1/auth/register`,
`/api/v1/auth/claim`, `/api/v1/admin/register-agent`) all use this
same wire envelope, so each integration test importing this helper
can drop the repeated request/JSON boilerplate.

### [`registerAgent`](./helpers.ts#L184)

_Function_

```ts
export function registerAgent(
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<TestAgent, Error>
```

### [`registerAndConnect`](./helpers.ts#L319)

_Function_

```ts
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error>
```

Register and connect an agent. Tracked for automatic cleanup.

### [`registerOnly`](./helpers.ts#L421)

_Function_

```ts
export function registerOnly(name: string): Effect.Effect<
  {
    client: ServerTestClient;
    agentId: string;
    apiKey: string;
    claimToken: string | undefined;
  },
  Error
>
```

Register an agent without connecting (for tests that need the raw client).

### [`resetCoreTestDb`](./server.ts#L337)

_Function_

```ts
export function resetCoreTestDb()
```

### [`ServerTestClient`](./helpers.ts#L44)

_Interface_

```ts
export interface ServerTestClient extends Omit<CloseableTestClient, "close"> {
  close(): Effect.Effect<void, never>;
  subscribeTo<D extends AnyNotificationDefinition>(
    definition: D,
  ): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
}
```

Spec B (#596) + #645: the legacy `waitForNotification(def, timeoutMs?)`,
`drainNotifications(): ReadonlyArray<...>`, and `notifications` Stream
wrappers were deleted. Consumers reach typed-payload Streams via
`client.subscribeTo(def)` (a one-line passthrough to
`TestClient.subscribe(def)`) or the broad-union `client.subscribeAll()`.
Ergonomic one-shot test sites use the top-level `awaitOneNotification`
helper below.

### [`setupAgentGroup`](./helpers.ts#L460)

_Function_

```ts
export function setupAgentGroup(
  count: number,
  opts?: { groupName?: string },
): Effect.Effect<
  {
    agents: ConnectedAgent[];
    conversationId?: ConversationId;
    taskId?: TaskId;
  },
  Error
>
```

Create N agents, all connected. Optionally create a group conversation.

### [`setupAgentPair`](./helpers.ts#L448)

_Function_

```ts
export function setupAgentPair(): Effect.Effect<
  { alice: ConnectedAgent; bob: ConnectedAgent },
  Error
>
```

Create two agents, both connected. No contacts needed (core has open access).

### [`startCoreTestServer`](./server.ts#L298)

_Function_

```ts
export function startCoreTestServer(opts: StartCoreTestServerOptions = {})
```

### [`stopCoreTestServer`](./server.ts#L311)

_Function_

```ts
export function stopCoreTestServer()
```

### [`trackClient`](./helpers.ts#L173)

_Function_

```ts
export function trackClient(client: ServerTestClient): void
```

## Files

- `app-endpoint.ts`
- `core-schema-sql.ts`
- `fakes.ts`
- `helpers.ts`
- `pglite-harness.ts`
- `rpc-error.ts`
- `server.ts`
