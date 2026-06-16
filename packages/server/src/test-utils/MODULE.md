# server-core/test-utils

_`packages/server/src/test-utils`_

## Purpose

Shared server-core test utility exports.

## Public surface

### [`AppEndpointHandlers`](./app-endpoint.ts#L48)

_TypeAlias_

```ts
export type AppEndpointHandlers = {
  readonly [D in AnyAppCallbackRpcDefinition as D["name"]]: AppEndpointHandler<D>;
};
```

Mapped over the closed `AnyAppCallbackRpcDefinition` union, keyed
by each definition's wire name. Mandates one handler per
task-callback RPC at construction time — adding a new entry to
`appCallbackMethods` becomes a compile error at every endpoint
construction site.

### [`AwaitNotificationError`](./helpers.ts#L49)

_TypeAlias_

```ts
export type AwaitNotificationError =
  | AwaitNotificationTimeoutError
  | AwaitNotificationClosedError;

/**
 * Stream-based one-shot waiter. Consumes `client.subscribe(def)` via
 * `Stream.runHead`, failing with `AwaitNotificationTimeoutError` on timeout
 * and `AwaitNotificationClosedError` when the transport closed before a
 * matching frame arrived. Distinguishing close from timeout keeps a dead
 * connection from masquerading as a missing notification.
 */
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<TestAgentClient, "subscribe">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<NotificationDelivery<D>, AwaitNotificationError> {
  const closed = () =>
    new AwaitNotificationClosedError({
      definition: definition.name,
    });
  return client.subscribe(definition).pipe(
    Stream.map(
      (params): NotificationDelivery<D> => ({
        definition,
        method: definition.name,
        params,
      }),
    ),
    Stream.runHead,
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: () => Effect.fail(closed()),
        onRight: Option.match({
          onNone: () => Effect.fail(closed()),
          onSome: (notification) => Effect.succeed(notification),
        }),
      }),
    ),
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new AwaitNotificationTimeoutError({
          definition: definition.name,
          durationMs: timeoutMs,
        }),
    }),
  );
}
```

### [`awaitOneNotification`](./helpers.ts#L60)

_Function_

```ts
export function awaitOneNotification<D extends AnyNotificationDefinition>(
  client: Pick<TestAgentClient, "subscribe">,
  definition: D,
  timeoutMs: number = DEFAULT_AWAIT_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<NotificationDelivery<D>, AwaitNotificationError>
```

Stream-based one-shot waiter. Consumes `client.subscribe(def)` via
`Stream.runHead`, failing with `AwaitNotificationTimeoutError` on timeout
and `AwaitNotificationClosedError` when the transport closed before a
matching frame arrived. Distinguishing close from timeout keeps a dead
connection from masquerading as a missing notification.

### [`closeAllClients`](./helpers.ts#L163)

_Function_

```ts
export function closeAllClients(): Effect.Effect<void, never>
```

### [`connectAppClient`](./helpers.ts#L271)

_Function_

```ts
export function connectAppClient(
  appId: AppId,
  appKey: AppKey,
  handlers: AppCallbackHandlers<AppCallbackContext>,
): Effect.Effect<TestAppClient, Error>
```

### [`ConnectedAgent`](./helpers.ts#L99)

_Interface_

```ts
export interface ConnectedAgent {
  client: TestAgentClient;
  agentId: AgentId;
  apiKey: AgentKey;
  name: string;
}
```

### [`connectTestClient`](./helpers.ts#L212)

_Function_

```ts
export function connectTestClient(opts: {
  agentId: AgentId;
  apiKey: AgentKey;
  wsUrl?: string;
}): Effect.Effect<TestAgentClient, Error>
```

### [`CoreSchemaSqlLoadError`](./core-schema-sql.ts#L24)

_TypeAlias_

```ts
export type CoreSchemaSqlLoadError =
  | CoreSchemaSqlAccessError
  | CoreSchemaSqlReadError;

const __dirname = dirname(fileURLToPath(import.meta.url));
```

### [`CoreTestRuntimeServerHandle`](./server.ts#L63)

_Interface_

```ts
export interface CoreTestRuntimeServerHandle {
  awaitAgentReady(
    agentId: AgentId,
    timeoutMs: number,
  ): Effect.Effect<CoreTestReadyOutcome, never, never>;
}
```

### [`CoreTestServer`](./server.ts#L118)

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
   * their own package-specific projection.
   */
  readonly spanExporter: InMemorySpanExporter | null;
}
```

### [`createTestAgent`](./helpers.ts#L189)

_Function_

```ts
export function createTestAgent(
  name: string,
  opts?: CreateTestAgentOptions,
): Effect.Effect<TestAgent, never>
```

### [`DEFAULT_TEST_ADMIN_USER_ID`](./server.ts#L43)

_Variable_

```ts
export const DEFAULT_TEST_ADMIN_USER_ID: UserIdValue = Schema.decodeUnknownSync(
  UserId,
)("00000000-0000-4000-8000-00000000ad00")
```

### [`getBaseUrl`](./server.ts#L389)

_Function_

```ts
export function getBaseUrl(): string
```

### [`getCoreDb`](./server.ts#L374)

_Function_

```ts
export function getCoreDb(): EffectKysely<Database>
```

### [`getCoreEncryptionEnvelope`](./server.ts#L382)

_Function_

```ts
export function getCoreEncryptionEnvelope(): EnvelopeEncryption
```

### [`getWsUrl`](./server.ts#L394)

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

### [`makeHandlerAppEndpoint`](./app-endpoint.ts#L117)

_Function_

```ts
export function makeHandlerAppEndpoint(args: {
  readonly id: ConnectionId;
  readonly handlers: AppEndpointHandlers;
}): AppEndpoint
```

Build an AppEndpoint whose outbound `originator.call` dispatches to
in-process handlers instead of going over a WebSocket. The endpoint
satisfies the same `{ connId, originator }` shape a connected app's
arm carries so `AppEndpointRegistry`, `AppRegistry`, and `sendRpcToClient` see ONE shape.

  - `originator.callback({ definition, params })` indexes `handlers` by
    `definition.name`. The
    mapped type guarantees every member of `AnyAppCallbackRpcDefinition`
    has a handler — no runtime "method not found" branch exists.
  - `originator.notify` / `failAllPending` are no-ops.
  - `originator.handle` / `originator.resolve` defect — an in-process
    endpoint never receives inbound frames; a call here is a wiring bug.

### [`makePgliteHarness`](./pglite-harness.ts#L69)

_Function_

```ts
export function makePgliteHarness(): Effect.Effect<
  PgliteHarness,
  PgliteHarnessError
>
```

Spin up a fresh PGlite instance with the core schema loaded.

### [`PGLITE_HOOK_TIMEOUT_MS`](./pglite-harness.ts#L24)

_Variable_

```ts
export const PGLITE_HOOK_TIMEOUT_MS = 30_000
```

Suggested timeout for pglite-backed beforeEach/afterEach hooks.

### [`PgliteHarness`](./pglite-harness.ts#L54)

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

### [`PgliteHarnessError`](./pglite-harness.ts#L42)

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

### [`postJson`](./helpers.ts#L304)

_Function_

```ts
export function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Effect.Effect<PostJsonResult, PostJsonError>
```

POST `body` as JSON to `${baseUrl}${path}` and resolve with
`{status, json}`. HTTP integration tests import this helper to avoid
repeated request/JSON boilerplate.

### [`registerAgent`](./helpers.ts#L170)

_Function_

```ts
export function registerAgent(
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<TestAgent, Error>
```

### [`registerAndConnect`](./helpers.ts#L288)

_Function_

```ts
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error>
```

Register and connect an agent. Tracked for automatic cleanup.

### [`registerApp`](./helpers.ts#L246)

_Function_

```ts
export function registerApp(
  baseUrl: string,
  manifest: AppManifest,
  inviteCode?: string,
): Effect.Effect<
  { readonly appId: AppId; readonly appKey: AppKey },
  AppRegistrationError
>
```

### [`resetCoreTestDb`](./server.ts#L348)

_Function_

```ts
export function resetCoreTestDb()
```

### [`setupAgentGroup`](./helpers.ts#L404)

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

### [`setupAgentPair`](./helpers.ts#L392)

_Function_

```ts
export function setupAgentPair(): Effect.Effect<
  { alice: ConnectedAgent; bob: ConnectedAgent },
  Error
>
```

Create two agents, both connected. No contacts needed (core has open access).

### [`startCoreTestServer`](./server.ts#L309)

_Function_

```ts
export function startCoreTestServer(opts: StartCoreTestServerOptions = {})
```

### [`stopCoreTestServer`](./server.ts#L322)

_Function_

```ts
export function stopCoreTestServer()
```

### [`trackClient`](./helpers.ts#L159)

_Function_

```ts
export function trackClient(client: TestAgentClient | TestAppClient): void
```

## Files

- `app-endpoint.ts`
- `core-schema-sql.ts`
- `fakes.ts`
- `helpers.ts`
- `pglite-harness.ts`
- `server.ts`
