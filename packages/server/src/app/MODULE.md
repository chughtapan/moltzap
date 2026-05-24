# server-core/app

_`packages/server/src/app`_

## Purpose

App layer public barrel.

The app layer owns AppHost, app registration, lease registry, server boot,
and service layer composition. It may import every lower protocol layer, but
lower layers must not import it because app is the composition root.

## Public surface

### [`AgentEndpointResolverLive`](./layers.ts#L227)

_Variable_

```ts
      // standalone.ts (`app.setContactService(...)`) AFTER this Layer has
      // already produced its ConversationService instance, so capturing
      // a snapshot here would always be `null`.
      ()
```

Build the resolver from its `Effect.make` constructor. The resolver is
a `Ref`-backed in-memory data structure with no upstream deps; the
Layer exists to register it under AgentEndpointResolverTag so
downstream layers (and `network.send`) can pick it up via Context.

### [`AgentEndpointResolverTag`](./layers.ts#L118)

_Class_

```ts

/**
 * `LeaseRegistry` for the #529 reshape additive `dispatch/*` admission
 * surface. In-process state (`Ref&lt;Map&lt;LeaseId, LeaseEntry>>` + per-lease
```

`AgentId → HashSet&lt;ConnectionId>` multimap maintained by the
`network/connect` success path and the WS disconnect finalizer. Read by
NetworkSendServiceTag for O(1) outbound routing.

### [`AppHooks`](./hooks.ts#L126)

_Interface_

`AppHooks` continues to key per-appId — `taskAuthorizeDispatch`
runs against the recipient's bound app, found via
`lookupAppForConversation`. `messageAuthorize` does NOT live here:
its lookup key is the TASK's `tm_endpoint_address`, not the bound
app. Default DM and default-group conversations have no bound app
but DO have a `tm_endpoint_address` (`DEFAULT_DM_TM_ADDRESS` /
`DEFAULT_GROUP_TM_ADDRESS` per `app-tm-registry.ts:30,38@adc2e18`),
so an address-keyed registry is the right shape.

### [`AppHost`](./app-host.ts#L208)

_Class_

```ts
   * via the connection uniformly;
```

### [`AppHostLive`](./layers.ts#L335)

_Variable_

```ts
// `appHost.setConversationService(conv)` wire-up — see
// `WireConvIntoAppHost` in `server.ts`.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  ParticipantServiceLive,
  ContactsServiceLive,
)
```

### [`AppHostTag`](./layers.ts#L163)

_Class_

```ts
>() {}
```

### [`AppTmRegistryLive`](./layers.ts#L237)

_Variable_

```ts
)
```

Build the app-TM registry and seed the default DM + group TMs at
boot. `tasks.tm_endpoint_address` is NOT NULL — every task needs a
registered TM at insert time, and non-app DMs/groups bind here.

### [`AppTmRegistryTag`](./layers.ts#L127)

_Class_

```ts
  LeaseRegistry
>() {}
```

In-process app-TM handler registry. `tm:app:&lt;id>` addresses
dispatch through here; default DM / group TMs register at boot via
AppTmRegistryLive.

### [`AuthServiceLive`](./layers.ts#L267)

_Variable_

```ts
export const AppHostLive = Layer.effect(
  AppHostTag,
  Effect.gen(function* ()
```

### [`AuthServiceTag`](./layers.ts#L140)

_Class_

```ts
export class SessionValidatorTag extends Context.Tag(
  "moltzap/SessionValidator",
)<SessionValidatorTag, SessionValidator | null>() {}
```

### [`Claim`](./lease-registry.ts#L217)

_Interface_

```ts
 * call exactly one of `finalize` or `rollback` on the release path.
 * The handle carries the lease id privately so callers cannot forge a
 * finalize against a different lease.
 */
export interface Claim {
  readonly leaseId: LeaseId;

  /**
   * CLAIMED → CONSUMED. Idempotent with respect to a successful durable
   * insert — calling twice on the same handle is a typed defect.
   */
  readonly finalize: (
    messageId: MessageId,
  ) => Effect.Effect<void, LeaseInvalidError, never>;
```

Active claim handle returned by `claim`. Implements
acquire-use-release: the wrapping `Effect.acquireUseRelease` MUST
call exactly one of `finalize` or `rollback` on the release path.
The handle carries the lease id privately so callers cannot forge a
finalize against a different lease.

### [`ConnectionHook`](./types.ts#L84)

_TypeAlias_

```ts
  connId: ConnectionId;
```

### [`ConnectionManagerLive`](./layers.ts#L216)

_Variable_

```ts
  ConversationServiceTag,
  Effect.gen(function* ()
```

### [`ConnectionManagerTag`](./layers.ts#L109)

_Class_

```ts
export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}
```

### [`ConnIdTag`](./layers.ts#L104)

_Class_

```ts
export class ContactsServiceTag extends Context.Tag("moltzap/ContactsService")<
  ContactsServiceTag,
  ContactsService
>() {}
```

Request-scoped connection id. Provided per WebSocket RPC dispatch by the
router; read by handlers via `yield* ConnIdTag`. Replaces the previous
`AsyncLocalStorage&lt;string>` + `getConnId` prop threading.

### [`ContactService`](./app-host.ts#L96)

_Interface_

```ts
    return this.reason;
```

### [`ContactsServiceLive`](./layers.ts#L307)

_Variable_

```ts
// requirements — a layer that depends on a sibling's output still shows that
// tag in RIn. `Layer.provideMerge(consumer, provider)` *does* wire them: it
// feeds `provider`'s outputs into `consumer`'s inputs AND keeps both sets of
// outputs visible to downstream layers.
//
// Service tier graph:
//
//   Tier 1 — ConnectionManager, AuthService, ParticipantService,
//            ContactsService.
//   Tier 2 — Presence, AgentEndpointResolver, AppTmRegistry (provideMerge over T1).
//   Tier 2.5 — NetworkSendService.
//   Tier 2.6 — LeaseRegistry.
//   Tier 3 — AppHost (db + connections + leases; seeds default
//            messageAuthorize hooks for the DM/Group TM addresses).
//   Tier 4 — ConversationService (db + participants + connections + AppHost).
//   Tier 5 — MessageService (every upstream + Encryption + DeliveryWebhook +
//            Webhook + TraceCapture + AppHost).
//   Tier 6 — TaskService (db + Conversation + Message).
//
// `Layer.provideMerge` (not `Layer.provide`) is load-bearing: every
// downstream tier sees ALL upstream Tags in its R-channel resolution,
// not just the immediately-above tier. RPC handler bodies can `yield*
// XServiceTag` for any service and have it resolved by the shared
// `dispatchRuntime` without a per-frame `Effect.provide`.
//
// `ConversationService` is built ABOVE `AppHost` but `AppHost` carries
// a backref into it (for the dispatch-deny path's removeParticipant
// call). The cycle is broken with a post-construction
// `appHost.setConversationService(conv)` wire-up — see
// `WireConvIntoAppHost` in `server.ts`.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  ParticipantServiceLive,
  ContactsServiceLive,
)
```

### [`ContactsServiceTag`](./layers.ts#L153)

_Class_

```ts
  WebhookClient
>() {}
```

### [`ConversationAppLookup`](./conversation-app-lookup.ts#L31)

_TypeAlias_

```ts
export type ConversationAppLookup =
  | { readonly _tag: "NoAppSession" }
```

Result of resolving the app session governing a conversation, by joining
`conversations.task_id → tasks.app_id`. Discriminates the four cases the
caller in AppHost.runAuthorizeDispatch must distinguish:

- `NoAppSession` — parent task has `app_id IS NULL` and the conversation
  is not archived. Caller default-grants (no moderator to consult).
- `AppBound` — parent task has `app_id IS NOT NULL`. Caller routes to
  the in-process hook (`AppHost.hooks` map) or remote registration
  (`AppHost.remoteRegistrations` map) for that `appId`.
- `ConversationArchived` — `conversations.archived_at IS NOT NULL`.
  Caller denies with reason `"conversation_archived"`. The archive
  check fires before the app discriminator so an archived app-bound
  conversation still denies (matches the pre-helper ordering).
- `ConversationNotFound` — no row matches the given `conversationId`.
  Caller default-grants (preserves the pre-helper fall-through).

The discriminated union — rather than `Option&lt;{...}>` plus a separate
archived flag — encodes exhaustiveness at the type level: every caller
`switch` ends with a `never` assignment and a future fifth case
becomes a compile error at every call site (Principle 4).

### [`ConversationServiceLive`](./layers.ts#L283)

_Variable_

```ts
    const conversations = yield* ConversationServiceTag
```

### [`ConversationServiceTag`](./layers.ts#L149)

_Class_

```ts
 * one place.
 */
export class WebhookClientTag extends Context.Tag("moltzap/WebhookClient")<
  WebhookClientTag,
  WebhookClient
>() {}
```

### [`CoreApp`](./types.ts#L98)

_Interface_

```ts
   * Fires when a WebSocket closes, after auth was established. Use for
   * per-user cleanup (e.g., `last_seen_at` updates). Does not fire for
```

### [`CoreConfig`](./types.ts#L24)

_Interface_

```ts
  corsOrigins: string[];
```

### [`createCoreApp`](./server.ts#L94)

_Function_

```ts
}

export function createCoreApp(config: CoreConfig): CoreApp
```

### [`DbTag`](./layers.ts#L91)

_Class_

```ts
export class AuthServiceTag extends Context.Tag("moltzap/AuthService")<
  AuthServiceTag,
  AuthService
>() {}
```

Postgres/PGlite database handle (Kysely&lt;Database>).

### [`DeliveryWebhookTag`](./layers.ts#L209)

_Class_

```ts
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new ParticipantService(db);
  }).pipe(Effect.withSpan("ParticipantServiceLive")),
```

Optional fire-and-forget message-delivery webhook. `null` means no
webhook — the fanout is skipped entirely.

### [`DisconnectionHook`](./types.ts#L92)

_TypeAlias_

```ts

export interface CoreApp {
  readonly port: number;
  onConnection: (hook: ConnectionHook) => void;
```

### [`DispatchAdmissionResult`](./hooks.ts#L55)

_TypeAlias_

```ts
  signal: AbortSignal;
```

### [`EncryptionTag`](./layers.ts#L94)

_Class_

```ts
>() {}
```

Optional envelope-encryption helper. null when encryption is disabled.

### [`ERROR_INVALID_JSON`](./server-constants.ts#L10)

_Variable_

```ts
export const ERROR_INVALID_JSON = "Invalid JSON"
```

### [`ERROR_INVALID_PARAMETERS`](./server-constants.ts#L11)

_Variable_

```ts
export const ERROR_INVALID_PARAMETERS = "Invalid parameters"
```

### [`HTTP_BAD_REQUEST`](./server-constants.ts#L3)

_Variable_

```ts
export const HTTP_BAD_REQUEST = 400
```

### [`HTTP_CONFLICT`](./server-constants.ts#L7)

_Variable_

```ts
export const HTTP_CONFLICT = 409
```

### [`HTTP_CREATED`](./server-constants.ts#L2)

_Variable_

```ts
export const HTTP_CREATED = 201
```

### [`HTTP_FORBIDDEN`](./server-constants.ts#L5)

_Variable_

```ts
export const HTTP_FORBIDDEN = 403
```

### [`HTTP_INTERNAL_SERVER_ERROR`](./server-constants.ts#L8)

_Variable_

```ts
export const HTTP_INTERNAL_SERVER_ERROR = 500
```

### [`HTTP_NOT_FOUND`](./server-constants.ts#L6)

_Variable_

```ts
export const HTTP_NOT_FOUND = 404
```

### [`HTTP_OK`](./server-constants.ts#L1)

_Variable_

```ts
export const HTTP_OK = 200
```

### [`HTTP_UNAUTHORIZED`](./server-constants.ts#L4)

_Variable_

```ts
export const HTTP_UNAUTHORIZED = 401
```

### [`LeaseBindingTuple`](./lease-registry.ts#L95)

_Interface_

```ts

/**
 * Audit binding tuple recorded at `mint` time. Used by `dispatches/get`
 * scope-enforcement and connection-close cleanup. Once recorded, the
 * tuple is immutable for the lease's lifetime.
 */
export interface LeaseBindingTuple {
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly moderatorConnectionId: ConnectionId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly appId: AppId;
}
```

Audit binding tuple recorded at `mint` time. Used by `dispatches/get`
scope-enforcement and connection-close cleanup. Once recorded, the
tuple is immutable for the lease's lifetime.

### [`LeaseInvalidError`](./lease-registry.ts#L177)

_Class_

```ts
 * surface a precise wire-error code per #529's typed-CONSUMED /
 * typed-EXPIRED requirements) and `expected` carries the set of
 * states the operation would have accepted.
 */
export class LeaseInvalidError extends Data.TaggedError("LeaseInvalidError")<{
  readonly leaseId: LeaseId;
  readonly state: LeaseState;
  readonly expected: ReadonlyArray<LeaseState>;
  readonly operation:
    | "resolve"
    | "claim"
    | "finalize"
    | "rollback"
    | "read"
    | "bindToConnection";
}> {
```

Tagged error channel for the registry's transition-rejecting paths.
The `state` carries the lease's CURRENT state (so callers can
surface a precise wire-error code per #529's typed-CONSUMED /
typed-EXPIRED requirements) and `expected` carries the set of
states the operation would have accepted.

### [`LeaseMintContext`](./lease-registry.ts#L150)

_Interface_

```ts
export interface LeaseMintContext {
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly moderatorConnectionId: ConnectionId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly appId: AppId;
}
```

Inputs to `mint`. Captured into the binding tuple plus mint
timestamp; the registry generates `leaseId` and `dispatchId`
internally via `crypto.randomUUID()` (≥122 bits entropy per spec).

### [`LeaseMintResult`](./lease-registry.ts#L165)

_Interface_

```ts
 * Lease mint result. Both ids are branded — calling code cannot
 * accidentally confuse them with `MessageId` / `TaskId` / generic
 * strings.
 */
export interface LeaseMintResult {
  readonly leaseId: LeaseId;
  readonly dispatchId: DispatchId;
}
```

Lease mint result. Both ids are branded — calling code cannot
accidentally confuse them with `MessageId` / `TaskId` / generic
strings.

### [`LeaseNotFoundError`](./lease-registry.ts#L201)

_Class_

```ts
 * lease exists but is in the wrong state. `LeaseNotFoundError` fires
 * when the id is unknown (caller forged it, or it aged out of the
 * retention window).
```

Lookup-by-id failure when the registry has no entry for the supplied
id. Distinct from `LeaseInvalidError` — that error fires when the
lease exists but is in the wrong state. `LeaseNotFoundError` fires
when the id is unknown (caller forged it, or it aged out of the
retention window).

### [`LeaseRecord`](./lease-registry.ts#L131)

_Interface_

```ts
export interface LeaseRecord {
  readonly dispatchId: DispatchId;
  readonly leaseId: LeaseId;
  readonly binding: LeaseBindingTuple;
  readonly state: LeaseState;
  readonly verdict: LeaseVerdict | null;
  readonly mintedAt: string;
  readonly resolvedAt: string | null;
  readonly consumedAt: string | null;
  readonly consumedMessageId: MessageId | null;
  readonly expiredAt: string | null;
  readonly leaseTimeoutMs: number | null;
}
```

Snapshot of a lease for `dispatches/get` and observability tests.
Mirrors the wire `LeaseRecordSchema` shape; ISO-8601 timestamps for
cross-boundary stability.

### [`leaseRecordToWire`](./lease-registry.ts#L452)

_Function_

```ts
  readonly leaseRetentionMs: number
```

Translation point between the in-process nested `LeaseRecord`
(binding field carries the full audit tuple) and the wire
`LeaseRecordSchema` shape (flat fields). Centralizing this keeps the
in-process representation as the single source of truth for the
authoritative tuple while the wire schema stays flat for simple
ergonomics on the moderator client side.

Advisory carry-over from review-senior-arch529 #2.

### [`LeaseRegistry`](./lease-registry.ts#L246)

_Interface_

```ts
 * normative enumeration):
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> PENDING
```

Public contract of the lease registry. Constructed once per server
lifetime; held by `AppHost` and the messages handler.

Implementation hint for impl-staff (#529 §3 stub-comment marker):
the timer wheel / min-heap for TTLs runs on a single fiber;
per-lease scheduler fibers are forbidden (Final Decision #9).
Manifest-driven TTLs come from `manifest.hooks.dispatch_authorize.
timeout_ms` (moderator response) and the verdict's `leaseTimeoutMs`
(post-grant lease).

### [`LeaseRegistryDeps`](./lease-registry.ts#L390)

_Interface_

```ts
   *   fiber. The recipient won't observe; the moderator's view stays
   *   consistent. Architect §3.
   *
   * - **CLAIMED → no-op (load-bearing rule 2)**: a CLAIMED lease has an
```

Constructor dependencies for the lease registry.
- `connections`: looked up at `emitRelease` time to find the
  recipient and at `dispatches/consumed` / `dispatches/expired`
  emission to find the moderator's connection.
- `leaseRetentionMs`: terminal-state retention window (CONSUMED /
  DENIED / EXPIRED / ABANDONED). Live states (PENDING / GRANTED /
  HOLD / CLAIMED) age out on their own TTLs.

### [`LeaseRegistryLive`](./layers.ts#L324)

_Variable_

```ts
//   Tier 6 — TaskService (db + Conversation + Message).
//
// `Layer.provideMerge` (not `Layer.provide`) is load-bearing: every
// downstream tier sees ALL upstream Tags in its R-channel resolution,
// not just the immediately-above tier. RPC handler bodies can `yield*
// XServiceTag` for any service and have it resolved by the shared
// `dispatchRuntime` without a per-frame `Effect.provide`.
//
// `ConversationService` is built ABOVE `AppHost` but `AppHost` carries
// a backref into it (for the dispatch-deny path's removeParticipant
// call). The cycle is broken with a post-construction
// `appHost.setConversationService(conv)` wire-up — see
// `WireConvIntoAppHost` in `server.ts`.
//
// The composition below is bottom-up by dependency order. Each stage merges
// a new service Layer on top of the lower tier, with the lower tier's
// outputs wired as the upper tier's inputs.

/** Tier 1 — zero cross-layer deps beyond Db. */
const Tier1 = Layer.mergeAll(
  ConnectionManagerLive,
  AuthServiceLive,
  ParticipantServiceLive,
  ContactsServiceLive,
);

/**
 * Tier 2 — Presence + resolver above Tier 1's ConnectionManager. The
 * resolver has no upstream deps (in-memory `Ref`)
```

### [`LeaseRegistryTag`](./layers.ts#L174)

_Class_

```ts
 * a `Ref`-backed in-memory data structure with no upstream deps;
```

`LeaseRegistry` for the #529 reshape additive `dispatch/*` admission
surface. In-process state (`Ref&lt;Map&lt;LeaseId, LeaseEntry>>` + per-lease
TTL fibers); no DB. Constructed once per server lifetime via
LeaseRegistryLive.

### [`LeaseState`](./lease-registry.ts#L110)

_TypeAlias_

```ts
export type LeaseState =
  | "PENDING"
  | "CLAIMED"
  | "GRANTED"
  | "CONSUMED"
  | "DENIED"
  | "EXPIRED"
  | "ABANDONED"
  | "HOLD";
```

Discriminated state of a lease. The registry's `Ref.modify`
transitions read this discriminator and reject illegal transitions
with a typed error (see LeaseInvalidError).

### [`LeaseVerdict`](./lease-registry.ts#L121)

_TypeAlias_

```ts
  | "EXPIRED"
  | "ABANDONED"
  | "HOLD";
```

Verdict shapes accepted by `resolve` — mirrors the wire decision.

### [`loadCoreConfig`](./config.ts#L155)

_Function_

```ts
export function loadCoreConfig(): LoadedConfig
```

Sync facade for the one boot entry (`app/dev.ts`) that runs outside an
Effect program. Safe here because this is the absolute process entrypoint:
a `ConfigError` bubbles up as an unhandled exception and fails startup —
the same outcome the previous throw-based loader produced.

### [`LoadedConfig`](./config.ts#L8)

_Interface_

```ts
export interface LoadedConfig {
  database: {
    url: string;
  };
  encryption: {
    /**
     * Derived from `ENCRYPTION_MASTER_SECRET`. When absent, the encryption
     * layer is disabled and messages are stored as plaintext. Operators who
     * want at-rest encryption must set this env var.
     */
    masterSecret: string | undefined;
  };
  server: {
    port: number;
    corsOrigins: CorsConfig;
  };
  devMode: boolean;
}
```

### [`logError`](./logging.ts#L15)

_Function_

```ts
export const logError = (
  message: string,
  annotations: Record<string, unknown> =
```

### [`logInfo`](./logging.ts#L3)

_Function_

```ts
export const logInfo = (
  message: string,
  annotations: Record<string, unknown> =
```

### [`logWarning`](./logging.ts#L9)

_Function_

```ts
export const logWarning = (
  message: string,
  annotations: Record<string, unknown> =
```

### [`lookupAppForConversation`](./conversation-app-lookup.ts#L75)

_Function_

```ts
export function lookupAppForConversation(
  db: Db,
  conversationId: ConversationId,
): Effect.Effect<ConversationAppLookup, never, never>
```

Resolve which app (if any) governs the conversation by joining
`conversations.task_id → tasks.app_id`. Replaces the dead in-memory
`conversationToSession` cache that lived on `AppHost`.

SQL shape (single round-trip):

```
SELECT conversations.archived_at,
       tasks.id     AS task_id,
       tasks.app_id AS app_id
FROM   conversations
INNER JOIN tasks ON tasks.id = conversations.task_id
WHERE  conversations.id = ?
LIMIT  1
```

`INNER JOIN` is correct: `conversations.task_id` is `NOT NULL` with a
FK to `tasks.id`, so every conversation row joins exactly one task
row. The query collapses the pre-helper archive-check + cache lookup
into one round-trip.

Branch ordering matches the pre-helper behavior at the caller:
archive check fires first, then the app discriminator. An archived
app-bound conversation returns `ConversationArchived`, not `AppBound`
— same as the inline archive query short-circuited before the cache
lookup ever ran.

Error channel is `never`: SQL errors surface as defects via
`catchSqlErrorAsDefect` at the call site in `AppHost.runAuthorizeDispatch`,
which is the existing convention for AppHost DB reads. Defects are
the right channel here — a database failure during admission is a
server-internal fault, not a moderator verdict.

### [`makeCoreHttpApp`](./http-routes.ts#L67)

_Function_

```ts
export function makeCoreHttpApp(options: CoreHttpAppOptions)
```

### [`makeLeaseRegistry`](./lease-registry.ts#L1151)

_Function_

```ts
  })
```

Construct the registry. The constructor is the only public factory
— `LeaseRegistry` is referenced as an interface from call sites.

Implementation: a `Ref&lt;Map&lt;LeaseId, LeaseEntry>>` plus a per-lease
scheduled TTL fiber (Effect-managed; safe to interrupt). Every state
transition is a `Ref.modify` predicate that returns the new entry +
a description of the side-effect (notification to emit, fiber to
cancel). The side-effects run AFTER the predicate commits — so the
state change is visible to concurrent readers before the
notification fires, satisfying the "first writer wins" invariant.

### [`makeNodeHttpServer`](./node-http-server.ts#L3)

_Function_

```ts
export function makeNodeHttpServer()
```

### [`makeSocketHandler`](./socket-handler.ts#L58)

_Function_

```ts
}

/**
 * Build the handler that the `/ws` route hands the upgraded socket
 * to. Each connection runs as one scoped Effect: the connection
 * scope owns the per-connection RPC originator, the
 * `ConnectionManager` entry, and every cleanup hook.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant C as Client
 *   participant WS as /ws route
 *   participant HS as handleSocket (this)
 *   participant RPC as acquireConnectionRpcClient
 *   participant CM as ConnectionManager
 *   participant R as socket reader fiber
 *   participant Cleanup as onExit
 *
 *   C->>WS: GET /ws Upgrade
 *   WS->>HS: socket
 *   Note over HS: connId = randomUUID&lt;br>writer + closeRequested Deferred
 *   HS->>RPC: acquireConnectionRpcClient(connId, write)
 *   Note over RPC: per-connection originator&lt;br>scope-bound finalizer fails pending Deferreds with NotConnectedError
 *   RPC-->>HS: originator
 *   HS->>CM: connections.add{id, write, shutdown, auth null, originator, ...}
 *   HS->>R: socket.runRaw — handleFrame
 *   Note over HS,R: Effect.raceFirst(reader, Deferred.await(closeRequested))&lt;br>raceFirst, not race — abrupt close still runs onExit
 *   R-->>Cleanup: socket closes
 *   Note over Cleanup: if authCtx → presenceService.setOffline&lt;br>for hook of disconnectionHooks — runUserHook sequentially&lt;br>agentEndpointResolver.remove(agentId, connId)&lt;br>leaseRegistry.abandon(connId)&lt;br>presenceService.removeConnection&lt;br>connections.remove(connId)
 * ```
 *
 * `Effect.raceFirst` (vs plain `race`) is load-bearing: an abrupt
 * disconnect still propagates as an interruption that triggers
 * `onExit`. Plain `race` would leak resources on abnormal close.
 *
 * Disconnection hooks run SEQUENTIALLY so each hook's cleanup
 * completes before the next observes post-close state.
 */
export function makeSocketHandler(options: SocketHandlerOptions) {
  return (
    socket: Socket.Socket,
  ): Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnectionTag>> =>
    Effect.scoped(openSocketSession(socket, options));
}

function openSocketSession(
  socket: Socket.Socket,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    const session = yield* makeSocketSession(socket);
    // Spec F (#617) §6 FRI cutover: one `ServerConnection` per socket.
    // Carries BOTH the inbound dispatcher (the static handler table from
    // `createCoreApp`) AND the outbound originator (server→client
    // appCallback path). The `id` mirrors the connId so logs trace
    // request ids back to the originating socket.
    const serverConn = yield* makeServerConnection({
      id: session.connId,
      handlers: options.handlers,
      capabilities: serverCapabilityProviders,
```

### [`MessageAuthorizeContext`](./hooks.ts#L84)

_Interface_

Server-side message-fan-out authorization hook surface (#560). The
hook (`messageAuthorize`) services the `messages/authorize` S→C RPC;
its context shape mirrors the wire `MessagesAuthorizeContextSchema`.

This hook restores the send-side gate that Phase 9b (#461) deleted
by removing `apps/onBeforeMessageDelivery` without an equivalent on
the new wire surface. Verdict shape is the 2-arm subset of #142's
5-arm `TaskManagerAction`: `Forward { recipients } | Block { reason }`.

Symmetric to `TaskAuthorizeDispatchHook`: same context fields
(`taskId`, `appId`, `conversationId`, `message`, `receivedAt`,
`clock`), same fail-closed posture, different verdict union.

### [`MessageAuthorizeHook`](./hooks.ts#L111)

_TypeAlias_

### [`MessageAuthorizeResult`](./hooks.ts#L107)

_TypeAlias_

2-arm verdict the TM declares for fan-out. `Forward { recipients }`
names the agents the server SHALL deliver to; `Block { reason }`
suppresses fan-out and surfaces `RpcFailure(HookBlocked)` to the
sender. `recipients` MUST be a subset of the conversation's
participants; the server does not re-fan to non-participants.
Empty `recipients` is legal — message lands in the sender's
transcript but is delivered to no one else.

The remaining `Modify | Close | AttachConversation` arms from
#142's 5-arm spec are out of scope for #560; see the design doc
§11 for rationale.

### [`MessageServiceLive`](./layers.ts#L360)

_Variable_

```ts
const Tier2NetworkSend = Layer.provideMerge(NetworkSendServiceLive, Tier2)
```

### [`MessageServiceTag`](./layers.ts#L179)

_Class_

```ts
  AgentEndpointResolverTag,
  AgentEndpointResolver.make,
);
```

### [`NetworkSendServiceLive`](./layers.ts#L255)

_Variable_

```ts

export const LeaseRegistryLive = Layer.effect(
  LeaseRegistryTag,
  Effect.gen(function* ()
```

`network.send` Layer. Composes the resolver, the connection manager,
and the app-TM registry into the NetworkSendService instance
the rest of the server holds via NetworkSendServiceTag.

### [`NetworkSendServiceTag`](./layers.ts#L136)

_Class_

```ts
  TaskServiceTag,
  TaskService
>() {}
```

Single outbound surface: `send` (directed) and `broadcast`
(fan-out).

### [`ParticipantServiceLive`](./layers.ts#L275)

_Variable_

```ts
    return host
```

### [`ParticipantServiceTag`](./layers.ts#L145)

_Class_

```ts
export class WebhookClientTag extends Context.Tag("moltzap/WebhookClient")<
  WebhookClientTag,
  WebhookClient
>() {}
```

### [`PresenceServiceLive`](./layers.ts#L315)

_Variable_

```ts
//            ContactsService.
//   Tier 2 — Presence, AgentEndpointResolver, AppTmRegistry (provideMerge over T1).
//   Tier 2.5 — NetworkSendService.
//   Tier 2.6 — LeaseRegistry.
//   Tier 3 — AppHost (db + connections + leases
```

### [`PresenceServiceTag`](./layers.ts#L158)

_Class_

```ts
 * webhook — the fanout is skipped entirely.
 */
export class DeliveryWebhookTag extends Context.Tag("moltzap/DeliveryWebhook")<
  DeliveryWebhookTag,
  DeliveryWebhookConfig | null
>() {}
```

### [`ResolvedServices`](./layers.ts#L467)

_Interface_

Shape of the fully-resolved services. Handler factories consume this
plain-object view rather than reading each tag individually.

### [`resolveServices`](./layers.ts#L491)

_Variable_

Resolves every service via Context into a plain-object view (matches the
shape handler factories already expect). Context requirements inferred
from the tag record.

### [`serverCapabilityProviders`](./capability-providers.ts#L60)

_Variable_

```ts
 * capability declaration: its wire schema accepts
 * `(conversationId | to | replyToId)` and the handler must resolve
 * `conversationId` via DB lookup before `MessageSendPermission` can
 * be obtained. Its capability stays hand-piped at the handler call
 * site — see `messages.ts → MessagesSend`.
 *
 * Gate-helper visibility (`@internal` exported, not `private`): TS
 * `private` blocks obtain helpers from reaching service checks via
 * the service Tag regardless of DI path. Gates stay on the service
 * class as `@internal` exported instance methods
```

Provider table keyed by `Context.Tag.key`. Each entry receives the
dispatcher-derived args (built by the descriptor's `argsOf`), narrows
via a single-level `as` cast, and returns the obtain helper's effect.

Both `makeServerConnection` call sites pass this same constant so the
`Caps` generic of `ServerConnectionConfig` agrees across them.

### [`ServerConfigLoader`](./config.ts#L104)

_Variable_

```ts
export const ServerConfigLoader: Effect.Effect<
  LoadedConfig,
  ConfigError.ConfigError
> = Effect.gen(function* ()
```

Effect-native server config loader. Reads env vars through `Config` so
missing/invalid values surface as typed `ConfigError` instead of thrown
`Error`. Callers already inside an Effect program `yield*` this; the one
sync entrypoint (`loadCoreConfig`) bridges via `Effect.runSync`.

### [`ServicesLive`](./layers.ts#L461)

_Variable_

All service Layers merged, with cross-layer deps resolved. Still requires
`DbTag | EncryptionTag` from a base Layer.

### [`SessionValidatorTag`](./layers.ts#L190)

_Class_

```ts
  Effect.gen(function* () {
    const resolver = yield* AgentEndpointResolverTag;
    const connections = yield* ConnectionManagerTag;
    return new NetworkSendService(resolver, connections);
  }).pipe(Effect.withSpan("NetworkSendServiceLive")),
```

Optional bearer-token session validator. `null` → bearer auth disabled.

### [`TaskAuthorizeDispatchContext`](./hooks.ts#L34)

_Interface_

```ts
      decision: "grant";
```

Server-side dispatch admission hook surface. The single hook
(`taskAuthorizeDispatch`) services the `dispatch/authorize` S→C RPC;
its context shape mirrors the wire `DispatchAuthorizeContextSchema`.
The legacy server-side names (`TaskAuthorizeDispatchContext` /
`TaskAuthorizeDispatchHook`) are retained for stability of in-tree
server consumers (in-process moderator registrations).

### [`TaskAuthorizeDispatchHook`](./hooks.ts#L65)

_TypeAlias_

```ts
 * transcript but is delivered to no one else.
 */
export type MessageAuthorizeResult =
  | { decision: "Forward"; recipients: ReadonlyArray<AgentId> }
```

### [`TaskServiceLive`](./layers.ts#L446)

_Variable_

```ts
}) satisfies Effect.Effect<ResolvedServices, never, unknown>
```

### [`TaskServiceTag`](./layers.ts#L184)

_Class_

```ts
 * `network.send` Layer. Composes the resolver and the connection
 * manager into the {@link NetworkSendService} instance the rest of the
```

### [`WebhookClientTag`](./layers.ts#L200)

_Class_

```ts
  AuthServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    return new AuthService(db);
  }).pipe(Effect.withSpan("AuthServiceLive")),
```

Shared outbound HTTP client used by MessageService.deliveryWebhook
for the fire-and-forget post-delivery push and by `WebhookSessionValidator`.
Separate Tag so connection pooling / semaphore sharing is controlled in
one place.

## Files

- `app-host.ts`
- `capability-providers.ts`
- `config.ts`
- `conversation-app-lookup.ts`
- `hooks.ts`
- `http-routes.ts`
- `layers.ts`
- `lease-registry.ts`
- `logging.ts`
- `node-http-server.ts`
- `server-constants.ts`
- `server.ts`
- `socket-handler.ts`
- `types.ts`
