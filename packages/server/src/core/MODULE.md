# server-core/core

_`packages/server/src/core`_

## Purpose

Narrow core wiring barrel for server-core internals.

## Public surface

### [`AgentEndpointResolverTag`](./layers.ts#L91)

_Class_

```ts
export class AgentEndpointResolverTag extends Context.Tag(
  "moltzap/AgentEndpointResolver",
)<AgentEndpointResolverTag, AgentEndpointResolver>() {}
```

`AgentId → HashSet&lt;ConnectionId>` multimap maintained by the
`agent/network/connect` success path and the WS disconnect finalizer. Read by
NetworkSendServiceTag for O(1) outbound routing.

### [`AppAuthServiceTag`](./layers.ts#L113)

_Class_

```ts
export class AppAuthServiceTag extends Context.Tag("moltzap/AppAuthService")<
  AppAuthServiceTag,
  AppAuthService
>() {}
```

### [`AppEndpointRegistryTag`](./layers.ts#L132)

_Class_

```ts
export class AppEndpointRegistryTag extends Context.Tag(
  "moltzap/AppEndpointRegistry",
)<AppEndpointRegistryTag, AppEndpointRegistry>() {}
```

### [`AuthServiceTag`](./layers.ts#L103)

_Class_

```ts
export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}
```

### [`ConnectionHook`](./types.ts#L10)

_TypeAlias_

```ts
export type ConnectionHook = (params: {
  agentId: AgentId;
  agentName: string;
  /** Owner user ID resolved at agent/network/connect time. */
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<void> | void;
```

### [`ConnectionHooks`](./layers.ts#L76)

_Interface_

```ts
export interface ConnectionHooks {
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}
```

The server-app's connection / disconnection hook arrays, read by the
`agent/network/connect` handler on a successful AGENT connect (it fires the
connection hooks once the agent arm is minted) and by the socket-close
finalizer (it fires the disconnection hooks). The arrays are the mutable
registration surface the `CoreApp.onConnection` / `onDisconnection`
accessors push into; the tag carries them into the request-scoped engine so
the native handler can fire them in place of the bare-frame
`fireConnectionHooks` path.

### [`ConnectionHooksTag`](./layers.ts#L81)

_Class_

```ts
export class ConnectionHooksTag extends Context.Tag("moltzap/ConnectionHooks")<
  ConnectionHooksTag,
  ConnectionHooks
>() {}
```

### [`ConnectionManagerTag`](./layers.ts#L62)

_Class_

```ts
export class ConnectionManagerTag extends Context.Tag(
  "moltzap/ConnectionManager",
)<ConnectionManagerTag, ConnectionManager>() {}
```

### [`ConnectionTag`](./layers.ts#L57)

_Class_

```ts
export class ConnectionTag extends Context.Tag("moltzap/Connection")<
  ConnectionTag,
  Connection
>() {}
```

Request-scoped connection. Provided per WebSocket RPC
dispatch by the typed dispatcher from the live three-arm `Connection`
arm; read by handlers via `yield* ConnectionTag`. Handlers that only
need the id read `.connId`; handlers that need the principal narrow on
`.auth._tag` (`AgentConnection` carries `AgentContext`, `AppConnection`
carries `AppContext`, `UnauthenticatedConnection` has neither).

### [`ContactsServiceTag`](./layers.ts#L122)

_Class_

```ts
export class ContactsServiceTag extends Context.Tag("moltzap/ContactsService")<
  ContactsServiceTag,
  ContactsService
>() {}
```

### [`ConversationServiceTag`](./layers.ts#L118)

_Class_

```ts
export class ConversationServiceTag extends Context.Tag(
  "moltzap/ConversationService",
)<ConversationServiceTag, ConversationService>() {}
```

### [`CoreApp`](./types.ts#L24)

_Interface_

```ts
export interface CoreApp {
  readonly port: number;
  onConnection: (hook: ConnectionHook) => void;

  /**
   * Fires when a WebSocket closes, after auth was established. Use for
   * per-user cleanup (e.g., `last_seen_at` updates). Does not fire for
   * connections that never authenticated.
   */
  onDisconnection: (hook: DisconnectionHook) => void;

  /**
   * Outbound-routing primitive. Apps emit events out-of-band via
   * `networkSendService.send(to, payload)` (directed) or
   * `networkSendService.broadcast(agentIds, payload, opts?)` (fan-out
   * across participants). Stable identity across the server lifetime.
   *
   * The backing `AgentEndpointResolver` is intentionally not exposed —
   * its mutable add/remove surface is server-internal lifecycle, not a
   * CoreApp consumer concern. Tests assert resolver state indirectly
   * via `networkSendService.send` outcomes.
   */
  readonly networkSendService: NetworkSendService;

  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for presence-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;

  /**
   * Wire a contact-policy gate for app-session admission and
   * conversation-creation paths. Absence of a checker means "allow all";
   * operators that need real policy decisions inject their resolver here.
   */
  setContactService: (checker: ContactService) => void;

  /**
   * Server-local lease registry for the
   * `dispatch/{request, authorize, release}` admission surface.
   * Stable identity across the server lifetime. Tests + advanced
   * consumers can read lease state directly via this handle.
   */
  readonly leaseRegistry: LeaseRegistry;
  close: () => PromiseLike<void>;
}
```

### [`createCoreApp`](./app.ts#L127)

_Function_

```ts
export function createCoreApp(config: CoreConfig): CoreApp
```

### [`DbTag`](./layers.ts#L41)

_Class_

```ts
export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}
```

Postgres/PGlite database handle (Kysely&lt;Database>).

### [`DisconnectionHook`](./types.ts#L18)

_TypeAlias_

```ts
export type DisconnectionHook = (params: {
  agentId: AgentId;
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<void> | void;
```

### [`DispatchAdmissionServiceTag`](./layers.ts#L147)

_Class_

```ts
export class DispatchAdmissionServiceTag extends Context.Tag(
  "moltzap/DispatchAdmissionService",
)<DispatchAdmissionServiceTag, DispatchAdmissionService>() {}
```

### [`EncryptionTag`](./layers.ts#L44)

_Class_

```ts
export class EncryptionTag extends Context.Tag("moltzap/Encryption")<
  EncryptionTag,
  EnvelopeEncryption | null
>() {}
```

Optional envelope-encryption helper. null when encryption is disabled.

### [`LeaseRegistryTag`](./layers.ts#L142)

_Class_

```ts
export class LeaseRegistryTag extends Context.Tag("moltzap/LeaseRegistry")<
  LeaseRegistryTag,
  LeaseRegistry
>() {}
```

`LeaseRegistry` for the `dispatch/*` admission surface. In-process
state (`Ref&lt;Map&lt;LeaseId, LeaseEntry>>` + per-lease
TTL fibers); no DB. Constructed once per server lifetime via
LeaseRegistryLive.

### [`makeTracingLayer`](./tracing.ts#L41)

_Function_

```ts
export function makeTracingLayer(input: TracingLayerInput): Layer.Layer<never>
```

Build a tracing Layer that wires the OTel SDK with the given span
processor. The processor controls how spans get exported (OTLP batch
in production; in-memory simple processor in tests).

### [`MessageServiceTag`](./layers.ts#L159)

_Class_

```ts
export class MessageServiceTag extends Context.Tag("moltzap/MessageService")<
  MessageServiceTag,
  MessageService
>() {}
```

### [`NetworkSendServiceTag`](./layers.ts#L99)

_Class_

```ts
export class NetworkSendServiceTag extends Context.Tag(
  "moltzap/NetworkSendService",
)<NetworkSendServiceTag, NetworkSendService>() {}
```

Single outbound surface: `send` (directed) and `broadcast`
(fan-out).

### [`PresenceServiceLive`](./layers.ts#L258)

_Variable_

```ts
export const PresenceServiceLive: Layer.Layer<
  PresenceServiceTag,
  never,
  ConnectionManagerTag
> = Layer.effect(
  PresenceServiceTag,
  Effect.gen(function* () {
    const connections = yield* ConnectionManagerTag;
    return yield* PresenceService.make(connections);
  }).pipe(Effect.withSpan("PresenceServiceLive")),
)
```

`PresenceServiceLive` constructs the full PresenceService
(subscriber registry + lease-derived status engine + `network/presence-changed`
fan-out). The R channel consumes `ConnectionManagerTag` — the only
construction dep, used by the fan-out to resolve each subscriber's
socket. `LeaseRegistryLive` consumes `PresenceServiceTag` as its
`transitionObserver`, so a missing wiring surfaces at `tsc --build`
via the unresolved R channel.

### [`PresenceServiceTag`](./layers.ts#L127)

_Class_

```ts
export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}
```

### [`readDefaultSpanProcessor`](./tracing.ts#L86)

_Variable_

```ts
export const readDefaultSpanProcessor: Effect.Effect<
  SpanProcessor | null,
  never
> = Effect.all({
  tracesEndpoint: Config.option(
    Config.string("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
  ),
  baseEndpoint: Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")),
}).pipe(
  Effect.map(({ tracesEndpoint, baseEndpoint }) => {
    const url = resolveTracesEndpoint(
      Option.getOrUndefined(tracesEndpoint),
      Option.getOrUndefined(baseEndpoint),
    );
    return url === null
      ? null
      : new BatchSpanProcessor(new OTLPTraceExporter({ url }));
  }),
  Effect.orElseSucceed(() => null),
)
```

Default span-processor factory for production boot.

Reads the OTLP endpoint env vars. If either is set, returns a
`BatchSpanProcessor` wrapping an `OTLPTraceExporter` pointed at the resolved
traces URL. The trace-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` takes
precedence over the base `OTEL_EXPORTER_OTLP_ENDPOINT`. If neither is set,
returns `null` — the caller falls through to a no-op tracing Layer (spans
stay in Effect's fiber context but are not exported).

### [`ResolvedServices`](./layers.ts#L450)

_Interface_

```ts
export interface ResolvedServices {
  readonly db: Db;
  readonly connections: ConnectionManager;
  readonly agentEndpointResolver: AgentEndpointResolver;
  readonly networkSendService: NetworkSendService;
  readonly authService: AuthService;
  readonly appAuthService: AppAuthService;
  readonly conversationService: ConversationService;
  readonly contactService: ContactsService;
  readonly presenceService: PresenceService;
  readonly appEndpointRegistry: AppEndpointRegistry;
  readonly leaseRegistry: LeaseRegistry;
  readonly messageService: MessageService;
  readonly taskService: TaskService;
  readonly encryption: EnvelopeEncryption | null;
}
```

Shape of the fully-resolved services. Handler factories consume this
plain-object view rather than reading each tag individually.

### [`resolveServices`](./layers.ts#L472)

_Variable_

```ts
export const resolveServices = Effect.all({
  db: DbTag,
  encryption: EncryptionTag,
  connections: ConnectionManagerTag,
  agentEndpointResolver: AgentEndpointResolverTag,
  networkSendService: NetworkSendServiceTag,
  authService: AuthServiceTag,
  appAuthService: AppAuthServiceTag,
  conversationService: ConversationServiceTag,
  contactService: ContactsServiceTag,
  presenceService: PresenceServiceTag,
  appEndpointRegistry: AppEndpointRegistryTag,
  leaseRegistry: LeaseRegistryTag,
  messageService: MessageServiceTag,
  taskService: TaskServiceTag,
}) satisfies Effect.Effect<ResolvedServices, never, unknown>
```

Resolves every service via Context into a plain-object view (matches the
shape handler factories already expect). Context requirements inferred
from the tag record.

### [`resolveTracesEndpoint`](./tracing.ts#L65)

_Function_

```ts
export function resolveTracesEndpoint(
  tracesEndpoint: string | undefined,
  baseEndpoint: string | undefined,
): string | null
```

### [`ServerBootFailedError`](./app.ts#L50)

_Class_

```ts
export class ServerBootFailedError extends Data.TaggedError(
  "ServerBootFailedError",
)<{
  readonly phase: "http-listen" | "default-app-connect";
  readonly cause: unknown;
}> {}
```

Typed fatal for boot failure. The `phase` discriminator names
which boot step failed:
- `"http-listen"` — step 5a's `NodeHttpServer.make` / `serverSvc.serve`
  typed `ServeError` (EADDRINUSE, EACCES, ...).
- `"default-app-connect"` — step 5c's `startDefaultApp` `BootDefaultAppError`
  (wrapping `client.connect()`'s `ConnectError`).

Step 5b's `installDefaultApp` has error channel `never`; SQL faults defect
and flow through the boot-failure `catchAllCause` envelope without a phase
tag.

### [`ServicesLive`](./layers.ts#L444)

_Variable_

```ts
export const ServicesLive = Tier7
```

All service Layers merged, with cross-layer deps resolved. Still requires
`DbTag | EncryptionTag` from a base Layer.

### [`TaskAuthorizationServiceTag`](./layers.ts#L155)

_Class_

```ts
export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}
```

### [`TaskServiceTag`](./layers.ts#L164)

_Class_

```ts
export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}
```

## Files

- `app.ts`
- `layers.ts`
- `tracing.ts`
- `types.ts`
