# server-core/test-utils

_`packages/server/src/test-utils`_

## Purpose

Shared server-core test utility exports.

## Public surface

### [`AwaitNotificationError`](./helpers.ts#L47)

_TypeAlias_

```ts
export type AwaitNotificationError =
  | AwaitNotificationTimeoutError
  | AwaitNotificationClosedError;
```

Represents await notification error conditions.

### [`awaitOneNotification`](./helpers.ts#L62)

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

**Returns:** The await one notification result.

### [`closeAllClients`](./helpers.ts#L174)

_Function_

```ts
export function closeAllClients(): Effect.Effect<void>
```

Executes the close all clients operation.

**Returns:** The close all clients result.

### [`ConnectedAgent`](./helpers.ts#L102)

_Interface_

```ts
export interface ConnectedAgent {
  client: TestAgentClient;
  agentId: AgentId;
  apiKey: AgentKey;
  name: string;
}
```

Describes connected agent.

### [`connectTestClient`](./helpers.ts#L251)

_Function_

```ts
export function connectTestClient(opts: {
  agentId: AgentId;
  apiKey: AgentKey;
  wsUrl?: string;
}): Effect.Effect<TestAgentClient, Error>
```

Executes the connect test client operation.

**Returns:** The connect test client result.

### [`CoreSchemaSqlLoadError`](./core-schema-sql.ts#L25)

_TypeAlias_

```ts
export type CoreSchemaSqlLoadError =
  | CoreSchemaSqlAccessError
  | CoreSchemaSqlReadError;
```

Represents core schema sql load error conditions.

### [`CoreTestDatabasePort`](./ports.ts#L23)

_Interface_

```ts
export interface CoreTestDatabasePort {
  execute(sql: string): PromiseLike<unknown>;
  reset(): PromiseLike<undefined>;
}
```

Database operations available to consumers of the published test harness.

### [`CoreTestReadyOutcome`](./ports.ts#L5)

_TypeAlias_

```ts
export type CoreTestReadyOutcome =
  | { readonly _tag: "Ready" }
```

Represents core test ready outcome values.

### [`CoreTestRuntimeServerHandle`](./ports.ts#L15)

_Interface_

```ts
export interface CoreTestRuntimeServerHandle {
  awaitAgentReady(
    agentId: AgentId,
    timeoutMs: number,
  ): Effect.Effect<CoreTestReadyOutcome>;
}
```

Process capabilities needed by in-process runtime tests.

### [`CoreTestServer`](./index.ts#L33)

_TypeAlias_

```ts
export type CoreTestServer = CoreTestServerPort;
```

Canonical published handle for a running core test server.

### [`CoreTestServerHandle`](./server.ts#L99)

_Interface_

```ts
export interface CoreTestServerHandle {
  baseUrl: string;
  wsUrl: string;
  db: EffectKysely<Database>;
  coreApp: CoreApp;

  /**
   * Pre-wired server handle that reports readiness from the live
   * `ConnectionManager`. Out-of-process consumers construct their own handle
   * over the WebSocket connection they already hold.
   */
  runtimeServer: CoreTestRuntimeServerHandle;

  /**
   * The auto-wired `InMemorySpanExporter`, or `null` when the caller
   * supplied a custom `spanProcessor`. Tests that want to inspect OTel
   * spans call `getFinishedSpans()` on this exporter and map them via
   * their own package-specific projection.
   */
  readonly spanExporter: InMemorySpanExporter | null;

  /** Published projection that keeps persistence and tracing vendors private. */
  readonly testPort: CoreTestServerPort;
}
```

Describes core test server handle.

### [`CoreTestServerPort`](./ports.ts#L41)

_Interface_

```ts
export interface CoreTestServerPort {
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly db: CoreTestDatabasePort;
  readonly runtimeServer: CoreTestRuntimeServerHandle;
  readonly spanExporter: CoreTestSpanExporterPort | null;
}
```

Published server handle composed only from server-owned test ports.

### [`CoreTestSpan`](./ports.ts#L29)

_Interface_

```ts
export interface CoreTestSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}
```

Stable projection of a finished server trace span.

### [`CoreTestSpanExporterPort`](./ports.ts#L35)

_Interface_

```ts
export interface CoreTestSpanExporterPort {
  getFinishedSpans(): readonly CoreTestSpan[];
  reset(): void;
}
```

Trace-capture operations available to test-harness consumers.

### [`createTestAgent`](./helpers.ts#L217)

_Function_

```ts
export function createTestAgent(
  name: string,
  opts?: CreateTestAgentOptions,
): Effect.Effect<TestAgent>
```

Creates test agent.

**Returns:** The created test agent.

### [`DEFAULT_TEST_ADMIN_USER_ID`](./server.ts#L45)

_Variable_

```ts
export const DEFAULT_TEST_ADMIN_USER_ID: UserIdValue = Schema.decodeUnknownSync(
  userId,
)("00000000-0000-4000-8000-00000000ad00")
```

Validates and decodes default test admin user id values.

### [`getBaseUrl`](./server.ts#L405)

_Function_

```ts
export function getBaseUrl(): string
```

Returns base url.

**Returns:** The get base url result.

### [`getCoreDb`](./server.ts#L392)

_Function_

```ts
export function getCoreDb(): EffectKysely<Database>
```

Returns core db.

**Returns:** The get core db result.

### [`getWsUrl`](./server.ts#L416)

_Function_

```ts
export function getWsUrl(): string
```

Returns ws url.

**Returns:** The get ws url result.

### [`loadCoreSchemaSql`](./core-schema-sql.ts#L93)

_Function_

```ts
export function loadCoreSchemaSql(): Effect.Effect<
  string,
  CoreSchemaSqlLoadError
>
```

Loads core schema sql.

**Returns:** The load core schema sql result.

### [`makePgliteHarness`](./pglite-harness.ts#L73)

_Function_

```ts
export function makePgliteHarness(): Effect.Effect<
  PgliteHarness,
  PgliteHarnessError
>
```

Spin up a fresh PGlite instance with the core schema loaded.

**Returns:** The created pglite harness.

### [`PGLITE_HOOK_TIMEOUT_MS`](./pglite-harness.ts#L23)

_Variable_

```ts
export const PGLITE_HOOK_TIMEOUT_MS = 30_000
```

Suggested timeout for pglite-backed beforeEach/afterEach hooks.

### [`PgliteHarness`](./pglite-harness.ts#L55)

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

Describes pglite harness.

### [`PgliteHarnessError`](./pglite-harness.ts#L42)

_TypeAlias_

```ts
export type PgliteHarnessError =
  | CoreSchemaSqlLoadError
  | PgliteCreateError
  | PgliteExecError
  | PgliteCloseError;
```

Represents pglite harness error conditions.

### [`postJson`](./helpers.ts#L293)

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

**Returns:** The post json result.

### [`registerAgent`](./helpers.ts#L192)

_Function_

```ts
export function registerAgent(
  baseUrl: string,
  name: string,
  opts?: { description?: string; inviteCode?: string },
): Effect.Effect<TestAgent, Error>
```

Registers agent.

**Returns:** The register agent result.

### [`registerAndConnect`](./helpers.ts#L273)

_Function_

```ts
export function registerAndConnect(
  name: string,
): Effect.Effect<ConnectedAgent, Error>
```

Register and connect an agent. Tracked for automatic cleanup.

**Returns:** The register and connect result.

### [`resetCoreTestDb`](./server.ts#L367)

_Function_

```ts
export function resetCoreTestDb()
```

Executes the reset core test db operation.

**Returns:** The reset core test db result.

### [`setupAgentGroup`](./helpers.ts#L402)

_Function_

```ts
export function setupAgentGroup(
  count: number,
  opts?: { groupName?: string },
): Effect.Effect<
  {
    agents: ConnectedAgent[];
    conversationId?: ConversationId;
  },
  Error
>
```

Create N agents, all connected. Optionally create a group conversation.

**Returns:** The setup agent group result.

### [`setupAgentPair`](./helpers.ts#L384)

_Function_

```ts
export function setupAgentPair(): Effect.Effect<
  { alice: ConnectedAgent; bob: ConnectedAgent },
  Error
>
```

Create two agents, both connected.

**Returns:** The setup agent pair result.

### [`startCoreTestServer`](./index.ts#L40)

_Function_

```ts
export function startCoreTestServer(opts: StartCoreTestServerOptions = {})
```

Start a test server and expose its package-owned integration ports.

**Returns:** A promise for the running server's integration ports.

### [`startCoreTestServerEffect`](./server.ts#L315)

_Variable_

```ts
export const startCoreTestServerEffect = Effect.fn("startCoreTestServer")(
  function* (opts: StartCoreTestServerOptions = {}) {
    yield* ensureNoCoreTestServerRunning();
    const db = yield* initializeTestDatabase();
    coreApp = createCoreTestApp(db, opts);
    yield* Effect.sleep(`${PGLITE_BOOT_DELAY_MS} millis`);
    return buildCoreTestServer(coreApp, db);
  },
)
```

Executes the start core test server effect operation.

### [`startCoreTestServerFull`](./server.ts#L330)

_Function_

```ts
export function startCoreTestServerFull(opts: StartCoreTestServerOptions = {})
```

Executes the start core test server full operation.

**Returns:** The start core test server full result.

### [`StartCoreTestServerOptions`](./ports.ts#L50)

_Interface_

```ts
export interface StartCoreTestServerOptions {
  readonly pgHost?: string;
  readonly pgPort?: number;
  readonly registrationSecret?: string;
  readonly adminUserId?: UserId;
}
```

Configures start core test server.

### [`stopCoreTestServer`](./server.ts#L338)

_Function_

```ts
export function stopCoreTestServer()
```

Executes the stop core test server operation.

**Returns:** The stop core test server result.

### [`trackClient`](./helpers.ts#L166)

_Function_

```ts
export function trackClient(client: TestAgentClient): void
```

Executes the track client operation.

## Files

- `core-schema-sql.ts`
- `helpers.ts`
- `index.ts`
- `pglite-harness.ts`
- `ports.ts`
- `server.ts`
