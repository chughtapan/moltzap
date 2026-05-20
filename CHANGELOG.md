# Changelog

All notable changes to MoltZap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Spec B obsolete-code remediation (#645)

- **BREAKING (`@moltzap/protocol/testing`):** `TestClient.notifications`,
  `TestClient.waitForNotification(def, timeoutMs?)`, and
  `TestClient.drainNotifications` deleted, along with the internal
  `notificationQueue` Ref, the 10ms `pollNotification` loop, and the
  `NotificationWaitError` tagged-error class. Callers consume
  notifications via the new `subscribe<D>(def, refinement?)` returning
  a typed `Stream<DecodedNotification<D>, TransportClosedError>` and
  `subscribeAll(refinement?)` for the broad-union escape hatch
  (paralleling Spec B's `MoltZapWsClient.subscribe` /
  `subscribeAll`).
- **BREAKING (`@moltzap/protocol/testing`):**
  `RealClientNotificationFilter` collapses from a three-field record
  (`emissionTag` / `conversationId` / `notificationNamePrefix`) to a
  predicate type alias `(notification) => boolean`. The sole producer
  (`_fixtures.ts → subscribeAll`) updates from `.subscribe({})` to
  `.subscribe()`; channel-side test-support packages
  (`@moltzap/openclaw-channel/test-support`,
  `@moltzap/nanoclaw-channel/test-support`,
  `@moltzap/claude-code-channel/test-support`) inherit the simplified
  shape automatically via re-export.
- **Behavior (`@moltzap/protocol/testing`):** `TestClient.close`
  propagates `TransportClosedError` to every in-flight Stream via
  the new `TestSubscriberRegistry.closeAll` → per-subscription
  `onClose` callback → `Stream.async`'s `emit.fail` (deterministic
  typed-error delivery, mirroring production's terminal-close
  semantic).
- **Internal (`@moltzap/server-core/test-utils`):** removed the
  per-`ServerTestClient` `helperBuffer` (`NotificationBuffer` Ref +
  `pullOneMatching` + `makeSubscribeStream`, ~95 LOC); the per-client
  broad-union notification snapshot now lives directly on the test
  client (`makeNotificationBuffer` forks a `subscribeAll()` pump that
  appends arrivals to a `Ref<ReadonlyArray<...>>`).
  `subscribeTo<D>(def)` polls this snapshot for the first matching
  frame, preserving the legacy `send → awaitOneNotification`
  historical-buffer semantic without resurrecting the deleted
  per-definition dedup ring. `ServerTestClient.notifications` and
  `ServerTestClient.drainNotifications` deleted.
- **Internal (`@moltzap/client/test-utils`):** removed the inline
  `SubscriptionFilter`-grammar reconstruction
  (`notificationMatchesFilter`, `refinementFromRealClientFilter`,
  `asNotificationParamsRecord`, `tagMatches`, `conversationMatches`,
  ~74 LOC); `subscribeRealClient` passes the predicate directly to
  `MoltZapWsClient.subscribeAll`.
- **Migration:** `client.waitForNotification(SomeNotification, 5_000)`
  becomes
  `client.subscribe(SomeNotification).pipe(Stream.runHead, Effect.timeoutFail(...))`.
  Existing `client.notifications.pipe(...)` filter chains become
  `client.subscribeAll().pipe(...)`. Channel re-exports require no
  caller-side update beyond passing the new predicate shape.
- **Fix (`@moltzap/protocol/testing`):** conformance properties
  `delivery/conversation-lifecycle` and `delivery/task-close-lifecycle`
  timed out post-consolidation because their sequential
  `RPC → wait → wait` patterns observed notifications that had
  dispatched before the second `subscribe` materialised. Per-actor
  `NotificationBuffer` now mirrors the server-core
  `connectTestClient` bridge (§3 of `12-test-client-stream-consolidation.md`):
  `acquireClient` installs a `subscribeAll()` pump appending every
  inbound notification to a `Ref<ReadonlyArray<...>>` snapshot bound
  to the actor's `notifications` field; `awaitOneNotification(buffer,
  def, timeoutMs)` polls the snapshot and removes the first matching
  frame. `ConversationActor` gains the `notifications` field;
  `awaitOneNotification` takes a `NotificationBuffer` instead of a
  `TestClient`. Same `Stream.runHead`-shaped consumer; opaque buffer
  shape means downstream conformance call sites only need
  `actor.notifications` instead of `actor.client`.

### Spec B (#596) — Notification consumption consolidation

- **BREAKING (`@moltzap/client`):** `MoltZapWsClient.subscribe(filter,
  handler)` and `MoltZapWsClient.waitForNotification(def, timeoutMs?)`
  deleted, along with the three-field `SubscriptionFilter` grammar and
  the pre-arrival `notificationsBufferRef` buffer. Callers now consume
  notifications via `subscribe<D>(def, refinement?)` returning a typed
  `Stream` and `subscribeAll(refinement?)` for the broad-union escape
  hatch. The user-defined-type-guard overload narrows the Stream's
  payload to `DecodedNotification<D, R>`.
- **BREAKING (`@moltzap/client`):** Public barrel drops
  `SubscriptionFilter`, `SubscriberHandler`, `NotificationSubscription`,
  `SubscriptionId`. Adds `TimeoutError`, `StreamClosedError`, and the
  `NotificationConsumerError` union from `./notification/errors`.
- **Behavior:** `MoltZapWsClient.close()` propagates `NotConnectedError`
  to every in-flight Stream via the registry's `closeAll` →
  per-subscription `onClose` callback → `Stream.async`'s `emit.fail`
  (deterministic typed-error delivery, replacing the deleted
  `failAllNotificationWaiters` semantic).
- **Behavior (`MoltZapService`):** `connect()` opens a private
  service-scope, forks `subscribeAll().pipe(Stream.runForEach(...))`
  into it, and `close()` interrupts the fiber + closes the scope. The
  public `connect()` signature is unchanged — no Scope leakage.
- **Protocol type-level (`@moltzap/protocol`):** `DecodedNotification<D>`
  extended to `DecodedNotification<D, R = unknown>`; the optional `R`
  is what the type-guard overload narrows. `isDecodedNotification` is
  now a public export — Stream-based consumers use it as a typed filter
  guard.
- **Test infrastructure (`@moltzap/server-core/test-utils`):** New
  `awaitOneNotification(client, def, timeoutMs?)` helper wraps
  `Stream.runHead + Effect.timeoutFail + Option.match` for one-shot
  test sites. `ServerTestClient.subscribeTo(def)` returns a typed
  Stream filtered off `TestClient.notifications`. The legacy
  `client.waitForNotification` binding on `ServerTestClient` is
  deleted; `client.drainNotifications` is now the passthrough Effect
  (`yield* client.drainNotifications`).
- **Test infrastructure (`@moltzap/protocol/testing`):**
  `TestClient.waitForNotification` / `TestClient.notifications` /
  `TestClient.drainNotifications` are preserved (spec #596 non-goal
  row 2). Conformance fixtures
  (`conformance/app/_driver.ts → waitForReleaseFrame`,
  `waitForObservabilityFrame`) migrate to the `notifications` Stream
  for shape-alignment with the new API.
- **Test infrastructure (`@moltzap/runtimes`):**
  `HarnessClient.waitForNotification` deleted; replaced with
  `HarnessClient.subscribe(def, refinement?)`. Internal
  `waitForTargetResponse` now uses fork-before-trigger via the Stream
  subscription.
- **Architecture (`@moltzap/client/runtime`):** New
  `composeServiceTeardown(scope, client)` helper sequences
  `Scope.close` BEFORE `client.close()` via `Effect.zipRight`. The
  service-owned scope holds the `subscribeAll → Stream.runForEach`
  fan-out fiber installed via `Effect.forkIn`; closing it interrupts
  the fiber before the ws-client teardown. Replaces an earlier
  two-`runFork` race in `MoltZapService.close()`.
- **Architecture (subscriber registry — AD1 snapshot semantic):**
  `SubscriberRegistry.dispatch(frame)` takes a structural snapshot of
  both `subsRef` (per-definition subs) and `subsAllRef` (broad-union
  subs) at iteration start. Subscribers added mid-dispatch see the
  frame only on the NEXT dispatch — late-arrivers do not get the
  in-flight frame, and concurrent `register/unregister` calls cannot
  starve sibling subscribers. User-supplied refinement predicates run
  inside a `safePredicate` try/catch so a throwing predicate filters
  the frame out for that subscriber rather than defecting the dispatch
  Effect.
- **Tests (property-based on subscriber dispatch):**
  `snapshot-semantics.test.ts` adds AD1 path-(a) properties
  exercising mid-dispatch register/unregister, predicate throws, and
  broad-union vs per-def fan-out invariants. Uses `Effect.yieldNow` to
  deterministically interleave register/unregister with dispatch.

### Spec F (#617) — Typed dispatcher unification + Connection facade

- **NEW:** `makeServerConnection` / `makeAgentClientConnection` /
  `makeTaskMasterConnection` in `@moltzap/protocol/transport/connection`.
  Per-kind typed Connection factories. Each takes an immutable
  handler table (REQUIRED slots enforced at construction via TS2741;
  OPTIONAL slots carry fail-CLOSED defaults) plus a
  `CapabilityProviderTable`. Inbound surface is the catalog's
  mapped-type record; outbound `call` is constrained to the kind's
  outbound RPC union.
- **NEW:** `RpcDefinition.slotDisposition` + `RpcDefinition.capabilities`
  on `defineRpc(...)`. `slotDisposition: optionalForbidden` marks a
  slot OPTIONAL with `ForbiddenError` (-32001) fail-CLOSED default.
  `capabilities` lists the `Context.Tag`s the handler `yield*`s; the
  dispatcher threads `Effect.provideServiceEffect` from the provider
  table in declaration order with first-failure short-circuit.
- **NEW:** `DispatchAuthorize` + `MessagesAuthorize` carry
  `slotDisposition: optionalForbidden`. Unbound TM-callback slots
  reply `Forbidden`.
- **NEW:** `MoltZapWsClientOptions.appCallbackHandlers`. Public
  TM-callback handler-table field on the production client.
- **NEW:** `TaskCallbackContext` + `AppCallbackHandlers` public types
  in `@moltzap/client`. Per-frame context and handler-table shape for
  the typed Connection's inbound dispatch.
- **NEW:** `OutboundCall.failAllPending` on the typed Connection
  interfaces. Lets the surrounding transport raise pending RPCs with a
  transport-specific message (the scope finalizer's generic message
  otherwise drops the consumer's reason string).
- **BREAKING:** `MoltZapWsClient.handleServerRpc`,
  `appCallbackHandlersRef`, `appCallbackRpcHandlers`,
  `buildInboundServerReply` DELETED. Runtime register API is gone
  (Spec F I1).
- **BREAKING:** `DuplicateServerRpcHandlerError` DELETED.
  Duplicate-key registration is a TS object-literal compile error.
- **BREAKING:** `ServerRpcContext` / `ServerRpcHandler` /
  `ErasedServerRpcHandler` type aliases DELETED from
  `client/src/ws-client.ts` + the `client/src/index.ts` barrel
  re-exports.
- **BREAKING:** `DUPLICATE_HANDLER_ERROR_TAG` DELETED from
  `client/src/ws-client-test-support.ts`.
- **BREAKING:** `MoltZapConnection.jsonRpcClient: JsonRpcClient` renamed
  and re-typed to `MoltZapConnection.originator:
  ServerConnection<DispatchContext>` — every socket now carries one
  typed Connection that hosts BOTH inbound dispatch and outbound
  TM-callback originator. `acquireConnectionRpcClient` derives it from
  `makeServerConnection<DispatchContext, never>({ handlers, ... })` and
  takes an optional `handlers: ServerHandlers<DispatchContext>`
  parameter (defaults to empty for test fixtures). Test stub
  `unusedJsonRpcClient` → `unusedOriginator` in
  `server/src/transport/connection.test-utils.ts`.
- **BREAKING:** public `makeJsonRpcClient` + `JsonRpcClient` re-exports
  DELETED from the protocol barrel. The originator helper is internal
  to `dispatch.ts`.
- **BREAKING:** `makeJsonRpcServer` / `handler` / `JsonRpcServer` /
  `RpcHandler` DELETED entirely. `packages/protocol/src/transport/json-rpc-server.ts`
  removed; `wireErrorFromInstance` re-exported from `transport/dispatch.ts`
  for `@moltzap/protocol/testing` consumers.
- **BREAKING:** `CoreApp.registerRpcMethod` DELETED. Static handler
  table is captured at `createCoreApp` time; Spec F I1 forbids
  post-construction mutation.
- **BREAKING:** `server/src/transport/context.ts → defineMethod` now
  returns a `HandlerSlot`-shaped binding (was: `RpcHandler`); the
  `Reqs` generic loses the `AppTags` upper bound (invariant
  `Context.Tag` parameters reject the broad bound; `FullLive` resolves
  Tags at runtime via the surrounding `ManagedRuntime`).
- **DOCS:** `packages/protocol/docs/architecture/11-typed-dispatcher.md`
  is the canonical reference for request handling and the internal
  originator lifecycle. `03-server-request-handling.md` and
  `04-client-call-lifecycle.md` DELETED — the §6 FRI cutover folds the
  client-call-lifecycle prose (scope-bound originator, pending
  insert-before-write, atomic insert/take, late-frame drop) into
  `11-typed-dispatcher.md` §6.

### Phase 12 — `@moltzap/protocol` finalization

- **BREAKING (Phase 12 — protocol surface):** Root facade reduced to
  152 lines / 114 named exports. The protocol package now exposes
  exactly the public surface and nothing more.
- **BREAKING:** `WIRE_CODES` and `ErrorCodes` aggregates deleted.
  Tagged-error classes carry their own `static readonly code` and
  `static readonly message` and self-register via `registerErrorClass`.
  `JSON_RPC_RESERVED_CODES` covers the five JSON-RPC 2.0 reserved
  codes only.
- **BREAKING:** Phantom-carrier `Params` / `Result` runtime properties
  on each definition dropped. Type-only accessors `ParamsOf<D>` /
  `ResultOf<D>` / `NotificationParamsOf<D>` remain the canonical type
  accessors (unchanged from prior phases).
- **BREAKING:** `Static` / `TSchema` re-exports dropped — consumers
  import directly from `@sinclair/typebox` (protocol no longer
  re-exports the dependency).
- **BREAKING:** Decode helpers `decodeRpcParams`, `decodeRpcResult`,
  `decodeRpcCall`, `decodeRpcRequest`, `decodeNotification`,
  `decodeFrame` deleted. Use `decodeServerInbound(json)` (client-side)
  and `decodeClientInbound(json)` (server-side) — single-call typed
  entry points returning a discriminated union over decoded payloads.
- **BREAKING:** `requestFrame` / `responseFrame` / `notificationFrame`
  free functions deleted. Use the per-definition methods:
  `Method.encodeRequest(id, params)`,
  `Method.encodeResponse(id, result)`, `Notification.encode(params)`,
  and `encodeErrorResponse(id, error)` for method-agnostic error
  responses.
- **BREAKING:** `isDecodedRpcRequest` / `isDecodedNotification` /
  `isDecodedNotificationInGroup` / `bindNotificationHandler` /
  `defineEffectNotificationHandlers` deleted. Notifications are decoded
  through `decodeServerInbound` / `decodeClientInbound` and dispatched
  by the `_tag` discriminant.
- **BREAKING:** `defineRpc` / `defineNotification` authoring
  primitives are no longer exported from the package root. Only
  protocol's own `methods.ts` files use them. Consumers register
  handlers against existing definitions via the new `handler(def, fn)`
  factory.
- **Added:** `handler<Ctx>(definition, fn)` factory replaces direct
  `RpcHandler` literal construction. `RpcHandler<Ctx>` is now
  de-generified — no per-method `D` parameter.
- **Added:** `MalformedFrameError` (transport) and
  `encodeErrorResponse(id, error)` (method-agnostic error encoder).
- **Restructured:** `packages/protocol/src/` now has `transport/`,
  `identity/`, `network/`, `task/`, `app/`, `testing/` subdirectories.
  Notifications are co-located with their methods in each layer's
  `methods.ts`. The flat `schema/` and `handlers/` directories are
  gone. Branded ID test-fixture constructors moved from
  `test-fixtures/branded-ids.ts` to `testing/branded-ids.ts`.
- **Removed:** `~119` dead symbols including most `Agent*Schema` /
  `Conversation*Schema` types, task lifecycle notifications
  (`TaskReady` / `TaskClosed` / `TaskAdmissionComplete` exports), the
  `App*Notification` family, and the deleted error classes `Blocked`,
  `IdentityRejected`, `AgentNoOwner`, `AgentNotFound`,
  `MaxParticipants`, `AppNotFound`, `RateLimited`, `ProtocolMismatch`.
  `InviteAgent` (`agents/invite`) and `InvitesCreateAgent`
  (`invites/createAgent`) are unaffected and remain exported.
- **Tooling:** `scripts/generate-json-schema.ts` deleted (referenced
  non-existent paths). `pnpm generate-schema` script removed.
  Protocol docs generation moved under
  `packages/protocol/scripts/generate-docs.ts`; the package script now
  regenerates the root Mintlify output in `docs/protocol/`.

### Added

- App-callback awaitable RPC channel over standard JSON-RPC request and
  response frames. `MoltZapWsClient.handleServerRpc(definition, handler)`
  registers handlers for descriptor-backed app-callback requests; the
  server allocates a `Deferred` per outbound request and finalizes pending
  Deferreds with `AppDisconnected` on connection scope close.
- Four app-callback RPC descriptors for app hooks:
  `apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`,
  `apps/onSessionActive`, `apps/onClose`. All four are
  awaitable; the lifecycle verbs reply with `{}` so the AppHost's
  `Effect.timeout(manifestMs)` applies and `app/sessionReady` ordering
  is preserved.
- New RPC descriptor `apps/attachConversation` for adding an existing
  conversation to a session's membership pipeline.
- `MoltZapApp.onBeforeDispatch`, `onBeforeMessageDelivery`,
  `onSessionActive`, `onClose`, and `attachConversation`
  on the app-sdk surface. Each `onX` registers a handler against the
  matching app-callback RPC descriptor; duplicate registration throws
  `AppError("DUPLICATE_HOOK_HANDLER")`.
- Typed errors in `@moltzap/app-sdk`: `AppHandlerError`,
  `AdmissionTimeoutError`, `AppDisconnected`, `AttachError`.
- `POST /api/v1/auth/register-admin` admin endpoint. Accepts a required
  `ownerUserId`; gated by constant-time compare against
  `config.registrationSecret`.
- New docs: [`docs/guides/app-hooks-rpc.mdx`](docs/guides/app-hooks-rpc.mdx)
  (hello-world echo bot, verdict-shape decision tables, webhook→RPC
  migration table) and
  [`docs/migration/webhook-to-rpc.mdx`](docs/migration/webhook-to-rpc.mdx)
  (step-by-step port for existing webhook code).

### Changed

- **BREAKING (wire format):** MoltZap now uses standard unary JSON-RPC
  request, response, and notification frames. Custom `type`,
  `direction`, `event`, and `data` envelope fields are removed; raw
  clients or servers that hand-craft JSON envelopes must use
  `{ jsonrpc, id, method, params }`, `{ jsonrpc, id, result/error }`,
  and `{ jsonrpc, method, params }`.
- AppHost composes hooks with `Effect.forEach` in registration-order
  FIFO with first-deny short-circuit. Hook signatures unified to
  `Effect<Verdict, never>` regardless of source (in-process or remote).
- Manifest hook timeout (`manifest.hooks.<name>.timeout_ms`) is now
  enforced at the AppHost call site via `Effect.timeout(manifestMs)`.
- **BREAKING (Phase 1C):** `RpcServerError`, `NotConnectedError`, and
  `RpcTimeoutError` moved from `@moltzap/client` to `@moltzap/protocol`.
  Re-import these from `@moltzap/protocol` (or a shared barrel) — the
  `@moltzap/client` re-exports are gone.
- **Internal (Phase 1C):** Protocol validation now uses a single shared
  frozen-singleton AJV instance. All schema compilation goes through one
  AJV configured identically, removing per-call AJV construction and
  ensuring consistent validation options across the codebase.

### Removed

- **BREAKING (Phase 1D):** `apps/onJoin` app-callback RPC + `OnJoinContext`
  schema + `MoltZapApp.onJoin()` SDK method. No consumer ever registered
  the hook (verified against werewolf manifest); plan §1.6 / §2.4. The
  schema also rejects `manifest.hooks.on_join` so apps that try to
  declare it now fail at parse time.
- **BREAKING (Phase 1D):** `app/hookTimeout` notification + every server
  emission site. No subscriber existed; surviving hook helpers still log
  warnings via `Effect.logWarning` on timeout.
- **BREAKING:** Boot-time `seed:` config block and the `seedAgentsEffect`
  task it drove. Yaml-configured agents (e.g., `seed.agents: [{ name:
  alice }]`) are no longer minted at standalone-server startup; the
  schema now rejects the `seed` field with `Unknown field "seed"`.
  Operators should mint their first agent directly via
  `POST /api/v1/auth/register` (open) or
  `POST /api/v1/admin/register-agent` (secret-gated, reentrant via
  PR #374). The retired flow used the public insert-only register
  route, which assigned `owner_user_id = devModeUserId` (a fresh
  random UUID per boot when `dev_mode.user_id` was unset) and so
  conflicted with subsequent admin/register-agent calls under the
  same name. README quickstart and `moltzap.example.yaml` updated to
  match.
- **BREAKING:** Manifest hook-webhook surface. The schema rejects:
  - `hooks.<name>.webhook` — HTTPS endpoint URL
  - `hooks.<name>.secret` — HMAC signing secret
  - `hooks.<name>.timeout_ms_remote_only` — remote-specific timeout
    override
- **BREAKING:** Hook-side webhook delivery code in
  `packages/server/src/adapters/webhook.ts`. The `WebhookClient.call`
  call sites used by AppHost for `before_dispatch` /
  `before_message_delivery` / `on_session_active` / `on_close` /
  `on_join` are gone. `WebhookClient` (the HTTP client class) and
  `signWebhookPayload` survive — they back the non-hook surfaces
  below.
- **BREAKING:** `packages/server/src/__tests__/integration/32-webhook-hooks.integration.test.ts`
  deleted (~600 LOC). Non-signature, non-precedence assertions migrated
  to `30-app-hooks-rpc.integration.test.ts`.
- **BREAKING:** `WebhookAdapterProbe` interface and
  `registerWebhookGracefulShutdown` function removed from
  `packages/protocol/src/testing/conformance/`. Replaced by an
  `app-disconnect-fail-policy` property that asserts pending
  app-callback admissions fail with `AppDisconnected` and AppHost
  applies fail-closed verdicts when the app's WS is severed.
- 30s upper bound on `hooks.<name>.timeout_ms` (B.4 follow-up #324).
  The schema in `packages/protocol/src/schema/apps.ts` now reads
  `Type.Integer({ default: 5000, minimum: 1 })` — no `maximum`.
- **BREAKING (Phase 1A — surfaces):** Surface RPC + notification surface
  removed end-to-end. Deleted RPCs: `surface/update`, `surface/get`,
  `surface/action`, `surface/clear`. Deleted notifications:
  `surface/updated` and `surface/cleared`.
- **BREAKING (Phase 1A — push):** Push-token RPCs `push/register` and
  `push/unregister` deleted; the server no longer maintains app
  push-token state.
- **BREAKING (Phase 1A — attestation):** Skill-attestation surface
  deleted. Removed: RPC `apps/attestSkill`; notification
  `app/skillChallenge`; manifest fields `AppManifest.skillUrl`,
  `AppManifest.skillMinVersion`, `AppManifest.challengeTimeoutMs`;
  attestation rejection codes; `ErrorCodes.SkillTimeout` and
  `ErrorCodes.SkillMismatch`.
- **BREAKING (Phase 1B — permissions):** Permissions surface deleted
  end-to-end. Removed: RPCs `permissions/grant`, `permissions/list`,
  `permissions/revoke`; notification `permissions/required`; manifest
  fields `AppManifest.permissions` and `AppManifest.permissionTimeoutMs`;
  DB table `app_permission_grants`; server modules
  `DefaultPermissionService`, `WebhookPermissionService`, and the
  `checkPermissions` server function; permission rejection codes;
  `ErrorCodes.PermissionTimeout` and `ErrorCodes.PermissionDenied`; CLI
  command `packages/client/src/cli/commands/permissions.ts`.
- **BREAKING (Phase 1C):** `@effect/rpc` bridge dropped. The internal
  shims `opaqueEffectSchema` and `bridgeEffectRpcType` are gone;
  protocol descriptors are JSON-Schema-only.

### Migration

If you wrote against the manifest-webhook surface, see
[`docs/migration/webhook-to-rpc.mdx`](docs/migration/webhook-to-rpc.mdx).
The TL;DR: delete the manifest webhook fields, register a handler on
`MoltZapApp` via `app.onX(handler)`, return `Effect<Verdict>` from the
handler, drop the HMAC validation (the apiKey on the WS connection is
the auth boundary).

The remaining server-level external-integration surfaces are
unaffected: `MessageService.deliveryWebhook`, `WebhookContactService`,
and the `services.contacts` / `services.users` YAML configs all
survive.

Phase 1B deleted the permissions surface entirely. There is no
permissions service. Apps that previously declared
`manifest.permissions` (or `manifest.permissionTimeoutMs`) must remove
those fields — the schema now rejects them. Clients that previously
read or wrote permission-grant state must adapt to the no-permissions
model: there are no `permissions/grant`, `permissions/list`, or
`permissions/revoke` calls, no `permissions/required` notification,
and no `services.permissions` YAML config.
