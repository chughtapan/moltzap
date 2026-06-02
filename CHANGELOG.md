# Changelog

All notable changes to MoltZap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed: per-method typed error channels + cast-free non-flat clients (#705)

Every RPC method now declares its own typed error channel and the wire
decodes errors by `_tag`, so a call's failure type is exactly that method's
errors — not the whole catalog. The global numeric-code error registry is
gone, and all three clients (agent, app, the server's reverse client) share
one cast-free `@effect/rpc` dispatch bridge.

- **Wire (`@moltzap/protocol`):** each wire error is a `Schema.TaggedError`
  discriminated by `_tag` (`Unauthorized`, `Forbidden`, `NotFound`,
  `TaskRejected`, …); there is no numeric `code` anywhere. `defineRpc` takes a
  required `errors` list, and the method's `errorSchema` is the
  `_tag`-discriminated `Schema.Union` of its effective errors (principal-gate
  errors for authenticated methods ∪ each capability's declared errors ∪ the
  handler's). The engine encodes/decodes a failure against that union
  directly. The wire `error` envelope is `{ _tag, message?, data? }`.
- **Removed:** the global error registry (`codeToClass`, `registerErrorClass`,
  `errorClassFor`, `isRegisteredErrorInstance`, `RegisteredTaggedError`) and
  the numeric JSON-RPC error codes it keyed on. Errors are now resolved
  structurally by class identity, not by a code lookup.
- **Clients:** the production clients use the NON-FLAT `RpcClient.make` — a
  per-method record keyed by wire tag. A typed `client.call(tag, payload)`
  returns `Effect<thatMethod'sResult, thatMethod'sErrors | NotConnected |
  Timeout>` with ZERO casts. The generic `sendRpc` wrapper and the flat client
  are deleted. The agent client, app client, and the server's reverse client
  all dispatch through one shared `makeTypedTransportCall` bridge.
- **Connection-close + timeout semantics:** a value RPC in flight when the
  socket drops (server close, `disconnect()`, or `close()`) now fails with
  `NotConnectedError` instead of vanishing as an interrupt — the reader-exit
  path closes the connection scope, which clears the engine's pending requests.
  A per-call timeout stays LOCAL: it fails the caller with `RpcTimeoutError`
  without writing an `@effect/rpc/Interrupt` frame or dropping the shared
  socket.
- **Reverse-handler error wire shape:** a reverse callback handler that rejects
  with a tagged error (e.g. `ForbiddenError`) now serializes the FLAT tagged
  error `{error:{_tag:"Forbidden", …}}`, matching the forward path, rather than
  the raw `@effect/rpc` `{_tag:"Cause"}` envelope. The moderator callbacks
  (`dispatch/authorize`, `messages/authorize`, `task/create`) declare
  `ForbiddenError` in their error channel so the engine can encode a handler
  rejection instead of emitting an un-encodable defect.

### Changed: manifest hook policies are required — close the fail-open `dispatch_authorize` hole (#735)

The receive-side dispatch authorization gate was fail-open on hook omission:
an app manifest that omitted `dispatch_authorize` (or the whole `hooks` block)
was silently granted admission for every recipient, reachable by any
wire-registered app. Each manifest hook policy is now a required discriminated
union, so "no policy" is unrepresentable — a compile error for in-code
manifests and a decode rejection at the wire boundary.

- **Wire (`@moltzap/protocol`):** `AppManifestSchema.hooks` and each of its
  three slots are required. Each slot is one of three policies:
  - `dispatch_authorize`: `{ kind: "grant" }` | `{ kind: "deny"; reason }` |
    `{ kind: "hook"; timeoutMs }`.
  - `message_authorize`: `{ kind: "forwardAllExceptSender" }` |
    `{ kind: "deny"; reason }` | `{ kind: "hook"; timeoutMs }`.
  - `task_create`: `{ kind: "accept" }` | `{ kind: "reject"; reason }` |
    `{ kind: "hook"; timeoutMs }`.
  The per-hook `{ timeout_ms }` entry is replaced by `timeoutMs` on the
  `hook` arm; `HookEntrySchema` is deleted. A static policy resolves the
  verdict in-process with no app round-trip; only `kind: "hook"` reaches the
  app over the wire under the fail-closed timeout envelope.
- **Server (`@moltzap/server-core`):** each hook runner switches exhaustively
  on `policy.kind` (no `default`, trailing `never` assertion). The
  unknown-app fail-closed arms are unchanged. The boot-installed default app
  declares the three open policies (`grant` / `forwardAllExceptSender` /
  `accept`) explicitly; its endpoint stays inert. The synthesized
  omission-default timeout fallback is removed.
- **Docs:** the app-building guide drops the omission-default prose and the
  `timeout_ms` field; every example declares all three policies explicitly.

**Migration:** there is no back-compat shim. An app row persisted under the
old schema (omitting policies) fails decode on read and must be re-registered.
The default-app row self-heals via the boot upsert; for dev/ephemeral
databases a fresh boot resets the rows. Any environment with persisted
non-default app rows must re-register those apps with explicit policies.

### Removed: external-bearer / webhook-session auth path (#725)

The `sessionToken` connect credential and its webhook-backed validator are
removed. `network/connect` now authenticates exactly two credentials:
`agentKey` (agent principals) and `appKey` (app principals). There is no
external-bearer token arm and no `services.sessions` config block.

- **Wire (`@moltzap/protocol`):** the `network/connect` params union drops its
  `{ sessionToken }` arm — only `{ agentKey }` and `{ appKey }` remain.
- **Server (`@moltzap/server-core`):** deletes the `SessionValidator`
  interface, the `WebhookSessionValidator` adapter, `SessionValidatorTag`,
  `CoreConfig.sessionValidator`, the connect handler's `authenticateSession`
  branch, and the `StandaloneBootPlan.sessionWebhook` boot-plan field +
  `standalone.ts → makeSessionValidator` wiring.
- **Config:** the YAML `services.sessions` arm is removed. `services.contacts`
  and the shared webhook parser (`WebhookServiceBinding` / `YamlServiceBlock`)
  are unchanged — contacts still delegate over HTTP.
- **Docs / example:** the `services.sessions` / bearer-token claims are
  dropped from the README, quickstart, introduction, the generated
  `network/connect` reference, and `moltzap.example.yaml`.

This is a deliberate feature removal: an external auth provider integrates by
minting `agentKey` / `appKey` credentials, not by validating bearer tokens at
connect time.

### Changed: wire validation engine TypeBox + AJV → Effect `Schema` (Half-2 slice 3, #723)

The wire-validation ENGINE moves off TypeBox + AJV onto Effect `Schema` —
the same decode engine the rest of the runtime already uses. Both `Ajv`
instances and every `ajv.compile` validator are deleted; `@sinclair/typebox`,
`ajv`, and `ajv-formats` are removed from `@moltzap/protocol`'s dependencies.
The JSON-RPC-2.0 wire DIALECT is unchanged — the exact same bytes flow on the
socket (`{jsonrpc:"2.0", id, method, params}` / `-32xxx` codes); only HOW
frames are validated/decoded changed.

- **Engine swap:** descriptor `paramsSchema` / `resultSchema` are Effect
  `Schema` values (`P`/`R extends Schema.Schema.AnyNoContext`);
  `validateParams` / `validateResult` are strict, excess-rejecting type
  guards (`closedStructGuard`) that decode via `Schema.decodeUnknownEither(…,
  { onExcessProperty: "error" })`. `decodeFrame` discriminates the three
  JSON-RPC frame shapes (Request / Response / Notification) through strict
  `Schema.decodeUnknownEither`; `validateAppManifest` maps the `ParseError`
  to `AppManifestInvalid` via `ParseResult.ArrayFormatter`.
- **AJV-strict parity (load-bearing):** `Schema.Struct` STRIPS excess keys by
  default, but `new Ajv({strict:true})` + `additionalProperties:false`
  REJECTED them. A shared `STRICT_DECODE` (`{ onExcessProperty: "error" }`) +
  the `closedStructGuard` factory restore that rejection at every wire decode,
  so the conformance malformed-frame, excess-property, and
  schema-exhaustive-fuzz proofs (`registerMalformedFrameHandling`,
  `registerRequestWellFormedness`, `registerSchemaExhaustiveFuzz`) still fire.
  The three former AJV `FormatRegistry` checkers (`uuid` / `uri` /
  `date-time`, including the `Date.parse` finiteness cliff) are now
  `Schema.pattern` / `Schema.filter` refinements on `brandedString` /
  `formatString`.
- **Branded ids** are `Schema.brand` (`brandedId` / `brandedString`); their
  decoded type (`string & Brand.Brand<…>`) is identical to the former
  `BrandedString`, so the ~16 cross-package `Value.Decode(<Brand>, raw)`
  brand-attach sites (server / client / openclaw-channel / nanoclaw-channel)
  become `Schema.decodeUnknownSync(<Brand>)(raw)`. Wire result types are now
  deeply `readonly` (Effect `Schema`'s `Schema.Array` yields `readonly T[]`).
- **Introspection rewired:** the docs walker (`scripts/docs/schema.ts`) reads
  `JSONSchema.make(schema)` draft-07 output instead of the TypeBox AST
  (generated RPC-reference docs are byte-identical); the conformance
  arbitrary walker delegates to Effect's native `Arbitrary.make`.
- **Out of scope (intentional):** `@moltzap/server-core`'s YAML-config
  validator (`config.ts → MoltZapConfigShape`) is a self-contained, non-wire
  TypeBox schema and is untouched — `@sinclair/typebox` stays a `server-core`
  dependency for it.

### Changed: cast-free capability middleware + principal-as-service (Half-2 slice 1, #723)

The dispatcher's capability layer gains its cast-free, principal-as-service
form on the two `messages/*` methods as an integration proof ahead of the
full port. A capability is now a first-class `CapabilityMiddleware`
(`provides` tag + typed payload-only `derivePayload` + typed `obtain`)
rather than an `argsOf(unknown, unknown): unknown` descriptor, and the
authenticated principal is read as an Effect service (`CurrentPrincipal`)
rather than threaded as a context parameter. `messages/send` and
`messages/list` now dispatch through this path with ZERO `as unknown as`
and no per-provider `args as Shape` cast.

- **New (protocol):** `CurrentPrincipal` — a protocol-owned `Context.Tag`
  carrying the request's authenticated `Principal` (the 2-arm `agent | app`
  union), `yield*`'d by `derivePayload`; `callerAgentId` reads the agent
  arm by discriminant. `CapabilityMiddleware<Params, Provides, Input, Env,
  Fail>` + `MiddlewaresOf` + the per-step `provideMiddleware` composition
  helper. `makeMiddlewareSlot` — the cast-free successor to `makeErasedSlot`
  for converted methods; it produces the SAME `ErasedSlot` shape so a
  middleware slot stores in the SAME slot table without a widening cast.
- **New (`@moltzap/server-core`):** `defineMiddlewareMethod` /
  `defineTaskMiddlewareMethod` weave each method's capabilities as a STATIC
  hand-expanded `provideServiceEffect` chain (declaration order preserved
  for Forbidden-before-state-probe) and provide `CurrentPrincipal` from the
  #720-narrowed arm — replacing the `dischargeCaps` runtime fold +
  `narrowToDispatchContext` for these methods. The per-arm totality lockstep
  is compiler-native and non-vacuous (pinned from the declared middleware
  tuple, so it bites even for caps the handler consumes only as an
  authorization side-effect, e.g. `messages/list`).
- **Behavior preserved:** the wire decode, the `-32xxx`
  `wireErrorFromInstance` projection, the #720 principal-kind gate, and the
  conversation-before-permission ordering on `messages/send` are unchanged
  (conformance + integration green). The remaining ~7 cap-bearing methods
  stay on the legacy `dischargeCaps` path until the full port.

### Changed: `MoltZapTMClient` SDK surface renamed to `MoltZapAppClient` (#705 §4.1)

The moderating-client SDK now matches the principal it speaks for: an **app**.
Every `TaskMaster`/`TM` identifier on the client + protocol-transport surface is
renamed to `App`, so the type you reach for is named after what it is. This is a
pure rename — the wire dialect and JSON-RPC method names (`dispatch/*`,
`messages/*`, `task/*`, `apps/register`) are byte-identical; no behavior changed.
The residual `tm_*` DB column and synthesized-value/reason literals
(`messages.tm_decision` column + its `idx_messages_tm_decision_tag` index, the
fail-closed `tm_unreachable` verdict reason, the `tm_remove` participant-removal
reason, and the `tm_policy` conformance reject reason) are likewise renamed to
their `app_*` form, and the speculative single-value `byAgentOrTm` enum field on
`task/conversation/participants/added` (zero readers) is deleted. Pre-launch
fresh-schema: `core-schema.sql` carries the renamed column directly and
`database.generated.ts` reflects `app_decision` — no migration shim.

- **BREAKING (`@moltzap/client`):** import `MoltZapAppClient` (was
  `MoltZapTMClient`) from `app-client.ts` (was `tm-client.ts`);
  `AppClientOptions` (was `TMClientOptions`) carries an
  `AppCallbackHandlers`-typed (was `TMHandlers`) `handlers` table.
- **BREAKING (`@moltzap/protocol/transport`):** `makeAppClientConnection` (was
  `makeTaskMasterConnection`) returns `AppClientConnection` (was
  `TaskMasterConnection`); callbacks run in an `AppCallbackContext` (was
  `TaskCallbackContext`). The `appCallbackMethods` group + `appCallableRpcMethods`
  partition replace `taskCallbackMethods` / `taskMasterRpcMethods`. The
  server-side `AppConnection` runtime class is unchanged (the renamed protocol
  type is `AppClientConnection`, kept distinct to avoid colliding with it).

### Fixed: `CoreApp.close()` teardown deadlock with live dispatch leases (#729)

- **Fixed (`@moltzap/server-core`):** `CoreApp.close()` could deadlock
  inside `Scope.close(appScope)` when a connection held a GRANTED dispatch
  lease at shutdown. Closing the app scope interrupts each WebSocket fiber,
  whose uninterruptible disconnect cleanup emits a `dispatches/expired`
  notification to the moderator connection; if that peer's socket was
  closing concurrently the cross-connection write parked forever on its
  closed write-latch, blocking scope teardown. `LeaseRegistry` now exposes
  `shutdown()`, which `closeCoreAppEffect` drains BEFORE `Scope.close` —
  fail-closing the registry so shutdown-time lease notifications drop
  instead of parking, and interrupting the live TTL/round-trip fibers.



Apps (task managers) now authenticate as their OWN principal over the
wire, the same way agents do. An app registers once over HTTP, gets a
server-minted `{appId, appKey}`, then opens a WebSocket and authenticates
with that `appKey` — the server mints a dedicated app-principal connection
that carries no agent identity. This replaces the in-process loopback the
default app used to ride on, so a task manager can now run as a separate
process (or a third party) instead of being wired into the server.

- **New (`@moltzap/server-core`):** `POST /api/v1/apps/register` accepts
  `{ manifest, inviteCode? }` and returns `201 { appId, appKey }` exactly
  once. `app_id` is server-issued via `gen_random_uuid()` — never
  client-controlled. Gated by the same constant-time `inviteCode` check as
  agent registration. Backed by a new `apps` table (mirrors `agents` minus
  owner/claim/status).
- **New (protocol):** the `network/connect` params union gains an `appKey`
  arm (`{ appKey, minProtocol, maxProtocol }`), disjoint from the
  `agentKey` arm. A successful `appKey` handshake returns
  a `HelloOk` with NO `agentId` (apps have no agent identity). The wire app
  client selects the arm by setting `TMClientOptions.appKey`.
- **Changed (`@moltzap/server-core`):** the connections map is now a
  three-arm discriminated union — `UnauthenticatedConnection` (pre-Connect)
  promotes in place to `AgentConnection` or `AppConnection` via one atomic
  `authenticate` transition. The single `auth._tag` runtime check that
  mints the arm is the only place principal kind is decided; handlers read
  the live arm and never re-derive it.
- **Removed (protocol):** the `TmAuthority` capability is dissolved
  (`packages/protocol/src/task/capabilities/tm-authority.ts` deleted, with
  its `nonTmAuthorityTaskRpcMethods` export). TM authority for the 8
  task-admin RPCs (`task/close`, `task/{add,remove}Participant`,
  `task/conversation/{create,archive,unarchive,addParticipant,removeParticipant}`)
  is now proved at request time by `assertAppOwnsTask` — the calling
  `AppConnection`'s `appId` must equal the bound task's `app_id`. The
  pre-cutover "not the registered task manager" `ForbiddenError` (-32001)
  surface is preserved.
- **Removed (`@moltzap/server-core`):** the in-process loopback
  (`app/loopback-connection.ts`) and the legacy single-shape
  `MoltZapConnection` connections map. Every app — including the
  boot-installed default — now carries one uniform `AppEndpoint`
  (`{ connId, originator }`); the default app holds an inert endpoint and
  is served by AppHost's manifest-default fast-path.
- **Renamed (protocol):** `nonTmAuthorityTaskRpcMethods` splits into
  `agentCallableTaskRpcMethods` and `appCallableTaskRpcMethods` to name the
  calling principal explicitly rather than by the dissolved capability.
- **Internal:** `PrincipalResolver`, `isAppConnection`,
  `isTmForAppBoundTask`, and the `CallerConnIdCtx` dispatch cast are all
  removed — the live connection arm carries the principal directly, so
  these resolver/cast shims no longer have a reader.

### Presence projection over `LeaseRegistry` — `presence/update` RPC + `away` state deleted (#706)

- **Breaking**: `presence/update` RPC removed and `away` state no
  longer exists; presence (`online` | `working` | `offline`) is now
  server-derived from lease lifecycle (`PENDING → GRANTED`
  transitions yield `working`; exits from `GRANTED|CLAIMED` and
  WS-close yield `online`/`offline`). Clients sending
  `presence/update` will receive `MethodNotFound`; clients whose
  `maxProtocol` predates this release will be rejected with
  `ProtocolMismatchError` (the exact `PROTOCOL_VERSION` cutoff is
  set by the release-tooling auto-bump at publish time).

### `adapters/` deleted — webhook transport unified on `@effect/platform/HttpClient` (#709)

Removes the bespoke ~282-line `WebhookClient` and the entire
`packages/server/src/adapters/` folder (5 files, ~700 lines).
Outbound webhooks (delivery fan-out, contact checks, session
validation) now ride on `@effect/platform/HttpClient`, matching
the project's Effect-native transport convention.

- **Removed (`@moltzap/server-core`):** `packages/server/src/adapters/`
  in full — `webhook.ts` (`WebhookClient` class + `signWebhookPayload` +
  4 tagged errors), `webhook.test.ts`, `fetch-client.ts`,
  `webhook-contact-service.ts`, `webhook-session-validator.ts`.
- **Removed (public surface, `@moltzap/server-core`):**
  `CoreConfig.webhookClient` (no in-repo consumer set it). The standard
  test-override path is now `Layer.succeed(HttpClient.HttpClient, mockClient)`.
- **Removed (internal, `@moltzap/server-core`):** `WebhookClientTag` —
  `MessageServiceLive` consumes `HttpClient.HttpClient` directly via
  the standard Tag; `MessageServiceDeps.webhookClient` is replaced by
  `MessageServiceDeps.httpClient`.
- **Moved (`@moltzap/server-core`):** The two webhook-backed identity
  adapters relocate from `adapters/` into the layer that owns the
  contract they implement —
  `identity/services/webhook-contact-service.ts` and
  `identity/services/webhook-session-validator.ts`. Their bodies swap
  the bespoke `webhookClient.call(...)` for
  `httpClient.execute(HttpClientRequest.post(...))` piped through
  `HttpClientResponse.filterStatusOk` and
  `HttpClientResponse.schemaBodyJson`; fail-closed semantics
  (`false` / `{valid: false}`) are preserved across every error path.
- **Moved (`@moltzap/server-core`):** The HMAC helper
  `signWebhookPayload` relocates to
  `packages/server/src/crypto/webhook-signature.ts` next to the rest
  of the envelope/sig kernel. The sole caller is
  `task/services/message.service.ts → fireDeliveryWebhook`, which
  uses `HttpClientRequest.bodyText(payload, "application/json")` so
  the bytes that go on the wire match the bytes fed to the HMAC
  (using `bodyJson`/`bodyUnsafeJson` would re-stringify the object
  and silently drift the signature; an explicit comment + a new
  regression test pin this).
- **Changed (`@moltzap/server-core`):** The prior
  `Effect.Semaphore(10)` outbound-concurrency cap is preserved as a
  process-wide shared semaphore via a new
  `packages/server/src/app/outbound-webhook-cap.ts` module exporting
  `applyOutboundWebhookCap(client)`, backed by a module-internal
  `Effect.Semaphore(10)` constructed once at import. Both the CoreApp's
  `HttpClientLive` (delivery webhook) and the standalone validator
  wiring (`standalone.ts` for the YAML-wired session/contact
  webhooks) pull from the SAME permit pool — matching the deleted
  `WebhookClient(10)` behavior of "one process, one cap covers
  every outbound webhook". Semantic delta vs main: the cap now
  scopes to `httpClient.execute(request)` (headers-arrival) rather
  than the full body-read/decode path, slightly weaker but still
  bounds concurrent outbound requests.
- **Changed (`@moltzap/server-core`):** The standalone
  HttpClient is constructed via
  `NodeHttpClient.layerUndiciWithoutDispatcher` provided with
  `NodeHttpClient.dispatcherLayerGlobal` (the process-global Undici
  dispatcher) instead of `NodeHttpClient.layerUndici`. The latter
  wraps a fresh `Undici.Agent` in `Effect.acquireRelease`; the
  surrounding `Effect.provide` scope would close the moment the
  yield returned the client, destroying the Agent before the
  validators could use it. The CoreApp's `HttpClientLive` keeps
  `layerUndici` because it is properly scoped under `ManagedRuntime`
  and disposes cleanly on `app.close()`.
- **Added (`@moltzap/server-core`):** Focused tests
  `identity/services/webhook-contact-service.test.ts` (7 cases —
  wire shape, success branches, every fail-closed branch, plus a
  `fast-check` property asserting fail-closed across the full
  remote-failure space). A new
  `task/services/message-service-delivery-hmac.test.ts` pins the
  HMAC-byte-exactness contract: the `X-MoltZap-Signature` header
  equals `signWebhookPayload(secret, captured_body_bytes)` for the
  exact bytes the test HttpClient saw on the wire, blocking any
  future `bodyText` → `bodyJson` regression.
- **Changed (`@moltzap/server-core`):** Response bodies are now
  explicitly drained on every webhook path (`Effect.tap((response)
  => response.text)` before `filterStatusOk`). `response.text` is
  `Effect.cached`, so the subsequent `schemaBodyJson` reuses the
  buffer on 2xx; on non-2xx the socket buffer no longer waits for
  the FinalizationRegistry to reap it.
- **Changed (`@moltzap/protocol`):** `@moltzap/protocol/identity`
  now also re-exports the runtime TypeBox schemas for `AgentId` /
  `UserId` / `ContactId` (previously the barrel exposed only the
  static types). Matches the convention `@moltzap/protocol/task`
  already uses for `AppId` / `ConversationId` / etc.; existing
  `import type` consumers are unaffected.

### Documentation restructure — JSDoc as canonical home for flow diagrams

- **Changed:** Per-flow architecture diagrams now live in JSDoc next
  to the symbol that owns each flow (Mermaid blocks inside the source
  file), not in sibling `packages/*/docs/architecture/*.md` files.
  The diagrams travel with the code; CI catches drift via
  `pnpm docs:check:mermaid` (validates every fenced ```mermaid block
  across `.md` / `.mdx`).
- **Removed:** Every `packages/*/docs/architecture/` folder (52 arch
  docs across 7 packages) and every per-package `ARCHITECTURE.md`
  index file. Load-bearing cold-reader content (project structure,
  data stores, glossary) folded into each package's `CLAUDE.md` and
  the existing `src/<folder>/README.md` files. Workspace-root
  `CLAUDE.md` documents the new policy once.
- **Changed:** Per-folder server READMEs
  (`src/{app,identity,network,task,transport}/README.md`) rewritten
  from mid-refactor "2A.0 / 2A.2 phase" language to describe the
  current file inventory and module purpose.
- **Changed:** Root `README.md` Documentation section now describes
  the full `pnpm docs:generate` pipeline (protocol reference MDX +
  per-folder `MODULE.md` + Mintlify mirror + coverage report +
  Mermaid lint). Added `@moltzap/claude-code-channel` to the
  packages table (was missing).
- **Changed:** `@failure` JSDoc tag defaulted in `eslint.shared.mjs`
  so packages don't each opt in; per-package
  `customJsDocTags` extends the list (server adds `internal`,
  protocol adds the RPC migration tags `error` /
  `relatedNotification` / `triggeredBy` / `file`).
- **Changed:** Spec D2 (#599) `moltzap start` flow diagram + exit-code
  contract + dedup branch inlined as JSDoc on
  `packages/client/src/cli/commands/start.ts` to match the new
  pattern.

### Config consolidation (#680) — single `src/config.ts`, Ajv dropped

Behavior-preserving consolidation of `@moltzap/server-core`'s config
layer. Same fields parsed, same env precedence, same boot decisions
(PGlite vs Postgres, CORS-required-outside-dev, Supabase-rejected-under-dev,
YAML `${VAR}` interpolation). One operator-visible behavior change: a
malformed config file now produces a slightly less polished error message.

- **Internal (`@moltzap/server-core`):** Five config sources fold into
  one `src/config.ts` — `app/config.ts` (the #676 `CoreConfig` home),
  `config/effect-config.ts`, `config/loader.ts`, `config/schema.ts`, and
  `runtime-surface/config.ts`. The `config/` and `runtime-surface/`
  folders are gone. Public surface narrows to `CoreConfig`,
  `StandaloneBootPlan`, `ConfigLoadError`, and one loader,
  `loadStandaloneConfig`; the former `MoltZapAppConfig` export is now a
  private `YamlConfig` type.
- **Internal (`@moltzap/server-core`):** `ajv` and `ajv-formats` are
  removed as dependencies. Config validation now runs through TypeBox
  `Value.Check` (`@sinclair/typebox`, already a dependency). Validation
  parity is preserved — the same malformed inputs are rejected
  (`encryption` block without `master_secret`, unknown keys, malformed
  `webhook_url`, sub-100ms `timeout_ms`, invalid `log_level`, the retired
  `seed` block, empty `database.url`). The error messages are softer than
  Ajv's keyword-by-keyword formatter; that is the accepted tradeoff.
- **Internal (`@moltzap/server-core`):** Dead `regex:` CORS prefix
  parsing is removed (the compiled-patterns array was never read).
  `corsOrigins` is exact-match only.

### Cursor-paginate the list-RPC surface (#692)

One cursor-pagination convention now covers the list-RPC surface:
`{ limit?, cursor? } → { <collection>, nextCursor? }` with an opaque
`(created_at, id)` keyset cursor (Decision 1 of spec #693). The cursor
encodes the last emitted row's millisecond-truncated `created_at` plus
its UUID tie-break, so pages never skip or duplicate rows that share a
timestamp.

- **BREAKING (`@moltzap/protocol`):** `AgentsList` (`agents/list`)
  result `agents` changes from `Record<AgentId, AgentCard>` to
  `Array<AgentCard>`, and gains `{ limit?, cursor? }` params plus an
  optional `nextCursor`. A map has no stable page ordering; the array
  matches `agents/lookup` / `agents/lookupByName`. All in-repo consumers
  (server handler, CLI `agents list`, integration + conformance) migrate
  in this change; there are no external consumers.
- **`ContactsList` (`contacts/list`):** additive — gains
  `{ limit?, cursor? }` params and an optional `nextCursor`. Existing
  callers keep working (`{}` params stay valid, `contacts` unchanged).
- **`TaskList` (`task/list`):** the half-wired cursor is finished — the
  result now carries `nextCursor` and the server threads `cursor`
  through `TaskService.list`. The `tasks` item type is unchanged
  (`Task[]`); the item reshape is deferred to a later change.
- **Branded `ListCursor`** (`@moltzap/protocol`): cursor / nextCursor
  are an opaque branded token. Clients echo it back unmodified; the
  server's `db/list-cursor.ts` codec is the only producer/decoder, and a
  server-package lint guard bans decoding the token elsewhere. A
  tampered token is rejected at the boundary as `InvalidParamsError`.
- **`MessagesList` is unchanged** (`sinceSeq` + `hasMore`): already an
  opaque, bounded, monotonic per-conversation seq cursor; request-bounded
  by construction.
- **Limit reconciliation (`@moltzap/protocol`):** Every list-RPC `limit`
  param now shares one schema (`ListLimitSchema`) backed by two exported
  constants, `DEFAULT_PAGE_LIMIT` (50) and `MAX_PAGE_LIMIT` (200). The
  six copy-pasted server default/clamp constants
  (`DEFAULT_TASK_LIST_LIMIT`, `DEFAULT_MESSAGE_HISTORY_LIMIT`,
  `DEFAULT_CONVERSATION_LIST_LIMIT`, `DEFAULT_AGENTS_LIST_LIMIT`,
  `DEFAULT_CONTACTS_LIST_LIMIT`, `MAX_MESSAGE_HISTORY_LIMIT`) are deleted
  in favor of importing the protocol constants, so the wire cap and the
  server clamp can no longer drift.
- **Cap raise — `task/conversation/list`:** `limit` ceiling raised
  100 → 200 to match the rest of the list surface (`MAX_PAGE_LIMIT`).
- **Cap raise — message history (server clamp):** the message-history
  server clamp raised 100 → 200, aligning to the protocol, which already
  allowed `limit` up to 200 on `messages/list` — fixes a latent
  protocol/server mismatch where the server silently truncated a
  protocol-valid request.
- **Internal (`@moltzap/client`):** The generic cursor-list drainer
  `drainPaginatedList` (and its cycle-guard error, renamed
  `MoltZapNonAdvancingCursorError` → `NonAdvancingCursorError`) moves
  from `@moltzap/openclaw-channel` into `@moltzap/client` so any channel
  or CLI that needs the complete result set (not just one page) can reuse
  it. openclaw's directory re-imports it; behavior is unchanged.

### Server folder rebalance (#708) — handlers + adapter/identity boundaries

Behavior-preserving relocation of `@moltzap/server-core` source files to
their concept-owning folders. No logic, wire, or config change; the
`@moltzap/server-core` public surface is unchanged (`src/index.ts` stays
`export {}`).

- **Internal (`@moltzap/server-core`):** Three RPC handlers move out of
  `task/handlers/` into the folder that owns their concept — `presence`
  to `network/handlers/`, `contacts` and `connect` to
  `identity/handlers/` (the Connect handshake validates the connect
  credential, an identity concern). Every importer is repointed
  (`app/server.ts` handler barrel, `transport/layer-tags.ts` doc
  citations) and the docs constants generators (`generate-cli-docs.ts`,
  `generate-constants-snippets.ts`) that read HELLO-policy numbers from
  `connect.handlers.ts` now read the new path.
- **Internal (`@moltzap/server-core`):** The `ContactService` interface
  moves from `app/app-host.ts` to `identity/services/contact-policy.ts`.
  `AppHost` keeps the field/setter/getter and imports the type;
  `adapters/webhook-contact-service.ts` now reaches into identity (a
  lower layer) instead of back into `app/`, removing an adapters→app
  reverse-layer edge.
- **Changed:** Per-folder server READMEs
  (`src/{task,network,identity}/README.md`) updated to list each
  handler under its new owning folder.

### Spec D3 (#600) — Cutover: delete `Conversations*`, singular `Task*` rename, MessagesSend reshape

The cutover phase of the layered-refactor sequence (`E → D1 → D2 →
D3`). D3 collapses the dual `Conversations*` / `Tasks*` wire surface
into the single `Task*` / `TaskConversation*` set from D1, reshapes
the `MessagesSend` / `MessagesList` boundary so `taskId` is required,
absorbs `TasksStoreMessage` into `MessagesSend` (TM-authority caller
identified server-side; no wire flag), and folds
`TasksGetMessages` / `TasksGetMessagesSince` into `MessagesList`
(canonical read RPC).

- **BREAKING (`@moltzap/protocol`):** All 11 `Conversations*` RPC
  descriptors deleted (`ConversationsCreate`/`List`/`Get`/`Update`/
  `Mute`/`Unmute`/`AddParticipant`/`RemoveParticipant`/`Leave`/
  `Archive`/`Unarchive`). Consumers migrate to the
  `Task*` / `TaskConversation*` family from D1.
- **BREAKING (`@moltzap/protocol`):** All 6 `conversations/*`
  notification definitions deleted
  (`conversations/created`/`updated`/`archived`/`unarchived`,
  `participants/added`/`removed`). Replaced by `task/conversation/*`
  + `task/conversation/participants/*` from D1, whose payloads carry
  `taskId` explicitly.
- **BREAKING (`@moltzap/protocol`):** Plural `Tasks*` surface
  collapses into singular `Task*`. `TasksCreate` →
  `TaskCreate` (D1 shape); `TasksList` → `TaskList({ limit?,
  cursor? })` (drops `appId`/`status` filters); `TasksClose` →
  `TaskClose`; `TasksAddParticipant` → `TaskAddParticipant`;
  `TasksRemoveParticipant` → `TaskRemoveParticipant`. `TasksGet`,
  `TasksCreateConversation`, `TasksCloseConversation`,
  `TasksStoreMessage`, `TasksGetMessages`, `TasksGetMessagesSince`
  delete (singular survivors handle the workflow).
- **BREAKING (`@moltzap/protocol`):** `MessagesSend` reshapes —
  `taskId: TaskId` REQUIRED; `to:` alternative addressing dropped;
  capabilities auto-provisioned by the dispatcher (R14a).
  `MessagesList` likewise requires `taskId`. The `to:
  "agent:<name>"` DM-resolution shortcut retires; callers now invoke
  `TaskCreate({ appId: DEFAULT_APP_ID, invitedAgentIds: [other] })`
  (dedup is implicit from shape) and then `MessagesSend`.
- **BREAKING (`@moltzap/protocol`):** Branded `TaskId` / `LeaseId`
  promoted to the wire — `MessagesSend.taskId`,
  `MessageReceivedNotification.taskId`,
  `DispatchAdmissionDecision.leaseId` all carry brand. Production
  callers brand untrusted strings at the boundary via
  `Value.Decode(TaskId, raw)` directly on the public TypeBox
  schemas; tests use the `agentId` / `taskId` / `conversationId` /
  `messageId` helpers from `@moltzap/protocol/testing`. (No
  `brand*` helpers are exported from the public protocol surface —
  the schema IS the validator.)
- **BREAKING (`@moltzap/protocol`):** `ConversationParticipantAccess`
  and `AddParticipantPermission` capability tags retire (the
  `Conversations*` RPCs that referenced them are gone).
- **BREAKING (`@moltzap/protocol`):** `RpcErrorPayload.data`
  narrows from `unknown` to `JsonValue | undefined` (R3).
- **BREAKING (`@moltzap/protocol`):** Per-kind catalog split —
  `agentClientRpcMethods` / `taskMasterRpcMethods` /
  `serverRpcMethods` partitions surface the agent-callable vs
  TM-only divide (R11).
- **BREAKING (`@moltzap/client`):** `MoltZapWsClient` class deleted;
  the SDK now exposes `MoltZapAgentClient` (outbound RPC + inbound
  notifications) and `MoltZapTMClient` (full duplex with TM-callback
  inbound dispatch). Channel plugins use `MoltZapAgentClient` via
  `MoltZapService` (R12/R13).
- **BREAKING (`@moltzap/client`):** `MoltZapChannelCore.sendReply`
  takes `(taskId, conversationId, text, ...)`; the channel-core
  message handler payload carries `{ taskId, message }`.
- **BREAKING (channel plugins):** `nanoclaw`, `openclaw`, and
  `claude-code` track `(taskId, conversationId)` per inbound and
  thread both into outbound `MessagesSend`. Channel directory ids
  shift to `task:<taskId>:<conversationId>` (Commit 11). The
  `conv:<id>` channel prefix retires.
- **BREAKING (`@moltzap/client`):** `MoltZapService.sendToAgent`
  calls `TaskCreate({appId, invitedAgentIds, initialConversation})`
  (previously `ConversationsCreate({type, participants})`);
  per-agent cache stores `{ taskId, conversationId }` tuples.
- **BREAKING (`@moltzap/server-core`):** `conversations.handlers.ts`
  deleted. `conversation-admin-authority.ts` deleted
  (collapses into `requireTmAuthority`).
- **BREAKING (server schema):** `conversation_participants.muted_until`
  column + `conversations.type` column + `conversation_type` ENUM
  all deleted. Mute is now a client-local concern. Conversation
  kind (DM vs Group) is inferred client-side from participant
  cardinality where display still needs the distinction.
- **BREAKING (`@moltzap/server-core`):** DM/Group runtime split
  collapses. `conversationService.findExistingDm`,
  `existingDmForCreate`, `createDmByAgentName`,
  `assertAddParticipantContactPolicy` deleted as dead post-cutover —
  participant-set dedup is owned by
  `taskService.findExistingTaskByParticipants` at the `TaskCreate`
  layer. `taskService.createConversation` + `CreateConversationInput`
  deleted (zero callers). `obtainContactPolicyForAdd` deleted
  (never wired to a handler). `obtainContactPolicyForCreate` drops
  the `type` parameter; `obtainGroupCapacityForCreate` derives
  capacity from cardinality.
- **BREAKING (`@moltzap/protocol`):** `inferConversationType` helper
  retires (zero callers post-collapse). `ConversationCreateAuthorization-
  Value` collapses to `{ ownerByAgentId }`; the `ExistingDm`
  short-circuit retires. `ObtainConversationCreateAuthorizationInput`
  drops `type`.
- **CLI (`@moltzap/client`):** `moltzap conversations` is
  partial-restructured for D3 — only the `history` subcommand
  survives; the legacy `list`/`get`/`archive`/etc. subcommands
  return in the D3 ADD slice once typed `Task*` /
  `TaskConversation*` CLI helpers land at the transport boundary.

### Orphan cleanup (#676) — `@moltzap/server-core` internal-surface sweep

Behavior-preserving cleanup of dead and redundant internal surface in
`@moltzap/server-core`. No wire-surface, public-API, or runtime-behavior
delta. The `pnpm dev` script is the only operator-visible change.

- **Internal (`@moltzap/server-core`):** Five unused `package.json`
  `exports` subpaths (`./app`, `./transport`, `./identity`,
  `./network`, `./task`) drop, along with the five dead layer-barrel
  files that backed them. Only `.` and `./test-utils` (the sole subpath
  with in-repo consumers) remain.
- **Internal (`@moltzap/server-core`):** Single-use indirection
  collapses — `server-constants.ts`, `logging.ts`, and
  `runtime/direct-run.ts` inline at their call sites and delete (the
  `runtime/` folder goes entirely, finishing #674); `hooks.ts` folds
  its four derived context types into `types.ts`; `dev.ts` merges into
  `standalone.ts`.
- **Internal (`@moltzap/server-core`):** `CoreConfig` moves from
  `app/types.ts` to `app/config.ts`, next to the other boot-input
  config types.
- **Internal (`@moltzap/server-core`):** Dead code swept — the private
  `fanOutToAgents` / `mapParticipant` methods and the entire
  `ParticipantService` chain (orphaned by spec-E #601 Decision D when
  agent-resolution moved into the `AddParticipantPermission` composite).
- **Operator (`@moltzap/server-core`):** `pnpm dev` now runs
  `standalone.ts` instead of the removed `app/dev.ts`. When
  `DATABASE_URL` is unset it boots embedded PGlite (the old `dev.ts`
  always required Postgres); set `DATABASE_URL` to keep using Postgres.

### Spec D1 (#598) — Additive `task/*` + `task/conversation/*` family

- **Additive (`@moltzap/protocol`):** New singular `task/*` namespace
  alongside the legacy plural `tasks/*` family. Eight new RPC
  descriptors (`TaskCreate`, `TaskLeave`,
  `TaskConversationCreate`/`List`/`Archive`/`Unarchive`/`AddParticipant`/`RemoveParticipant`)
  and five new notifications (`task/conversation/created`/`archived`/
  `unarchived`/`participants/added`/`participants/removed`) coexist
  with the legacy `Conversations*` family during the D1 transitional
  window. Spec D3 (#600) deletes the legacy surface inside the same
  orchestration (parent epic #602).
- **Additive (`@moltzap/protocol`):** New `AppId` branded id and
  `DEFAULT_APP_ID =
  "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb"` constant. `TaskCreate`
  takes `appId: AppId` (required, branded); `tmType` eliminated from
  the wire. Optional `initialConversation` field for atomic task +
  first-conversation creation. Result shape
  `{ task, conversation: Conversation | null }`.
- **Additive (`@moltzap/protocol`):** New `ParticipantNotAdmittedError`
  (`-32023`) — fired by `TaskConversationCreate` /
  `TaskConversationAddParticipant` when a target agent is not in
  `task_participants` for the task. Distinct from the existing
  `ForbiddenError` so clients can distinguish "wrong agent id shape"
  from "agent exists but is not admitted to this task" without
  parsing messages.
- **Additive (`@moltzap/protocol`):** New `archivedAt?: DateTimeString`
  field on `Conversation`; populated for archived rows so clients
  filter `archivedAt !== undefined` locally on
  `TaskConversationList` responses.
- **Behavior (`@moltzap/server-core`):** Every legacy `Conversations*`
  handler emits one structured `Effect.logWarning` at entry
  (`{ deprecated, replaceWith }` annotations) per spec body Contract
  decision. D3 deletes the emission alongside the legacy handlers.
  Pinned by `src/task/handlers/conversations.deprecation.test.ts`.
- **Behavior (`@moltzap/server-core`):** Every mutating
  `task/conversation/*` handler dual-emits BOTH the legacy
  `conversations/*` notification AND the new `task/conversation/*`
  notification inside the same transaction. Recipient fan-out matches
  the legacy semantics; the new payload shapes carry `taskId`
  explicitly. Per-flow walkthrough at
  `packages/protocol/docs/architecture/task-conversation-family.md`.
- **Service surface (`@moltzap/server-core`):** New `TaskService`
  package-private helpers: `findExistingTaskByParticipants`
  (DEFAULT_APP dedup, sibling to legacy
  `existingDmForCreate`), `requireAgentsAreInTaskParticipants`
  (D1 participant-admitted invariant — admitted-OR-pending both
  pass), `leaveTask` (bulk per-cid delete + last-participant task
  closure), `archiveTaskConversation` / `unarchiveTaskConversation` /
  `addTaskConversationParticipant` /
  `removeTaskConversationParticipant`. New `ConversationService`
  helpers: `loadById`, `taskIdForConversation`.
- **Test infrastructure (`@moltzap/protocol/testing`):** Seven new
  conformance properties under
  `packages/protocol/src/testing/conformance/task/task-conversation-family.ts`,
  one per new wire method, registered in `TASK_PROPERTIES`.
- **Test infrastructure (`@moltzap/server-core/__tests__`):** New
  integration suite
  `packages/server/src/__tests__/integration/task/task-conversation-family.test.ts`
  exercises real-Postgres happy-path, dedup, atomic init-conversation,
  participant-admitted invariant, and dual-emit notification fan-out
  end-to-end.

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
  `connectTestClient` bridge (§3 of `test-client-stream-consolidation.md`):
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
  `SubscriptionId`. Adds `NotificationTimeoutError`,
  `NotificationStreamClosedError` (with its `StreamCloseReason`
  discriminant — `"client-closed"` | `"stream-completed"` |
  `"transport-disconnected"`), and the `NotificationConsumerError` union
  from `./notification/errors`.
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

### Spec C (#597) — `channel-base` extraction + lease-lifecycle consolidation

- **Added (`@moltzap/client`):** New `@moltzap/client/channel-base`
  subpath export collecting the channel-plugin scaffolding shared
  across the first-party channels (replaces the per-channel copy-paste
  of lease projection + formatter helpers).
- **Added (`@moltzap/client/channel-base`):** Canonical
  `LeaseAlreadyConsumed` `TaggedError` plus the
  `projectLeaseInvalid(error)` predicate, the `catchLeaseInvalid(self)`
  wrapper, and the `LeaseInvalidProjectionError<E>` type alias — one
  shared lease-invalid projection surface instead of each channel
  re-deriving the "lease already consumed" case.
- **Added (`@moltzap/client/channel-base`):** `LeaseStore<HostKey, T>`
  and `LeaseGuard` primitives for channel-local lease bookkeeping.
- **Added (`@moltzap/client/channel-base`):** Consolidated
  `formatCrossConv` / `formatGroupBlock` formatters plus the
  `getGroupFields(meta)` narrowing helper (returns `null` when the
  conversation is not a group, so callers skip the block entirely;
  the `json-header` markup variant returns an empty string by design,
  since openclaw consumes `getGroupFields` directly rather than
  rendering a block).
- **Added (`@moltzap/openclaw-channel`):** `onLeaseConsumed` callback
  on the openclaw channel's `MoltzapChannelPluginDeps`, fired when the
  server reports a lease as already consumed so the channel can drop
  local state.
- **Behavior:** Deterministic reconnection is now triggered via
  `MoltZapWsClient.disconnect()` (replacing the toxiproxy
  `reset_peer` fault-injection path) — reconnection tests drive the
  client API directly instead of the proxy.
- **Wire-code correction:** lease-invalid rejections surface as
  `-32001 ForbiddenError` (corrected from `-32011`) with
  `data.reason === "LeaseInvalid"`.

### Spec E (#601) — R-channel capability primitives + TaskService cutover

- **Internal:** R-channel typed capability tags
  (`TmAuthority`, `TaskReadAccess`, `ConversationParticipantAccess`,
  `ConversationInTask`, `AgentExists`, `AgentInTaskParticipants`,
  `ContactPolicyAllowsReach`, `TaskActive`, `ConversationNotArchived`,
  `ValidReplyTarget`, `NoReplyTarget`, `GroupCapacityForCreate`,
  composite `MessageSendPermission`) plus matching `obtain*` / `refine*`
  smart constructors. Each smart constructor wraps today's runtime
  check exactly once per request and produces a typed token + carried
  payload row. (Tag classes + `refine*` helpers live in
  `packages/protocol/src/task/capabilities/`; the `obtain*` logic lives
  in `packages/server/src/app/capability-providers.ts`, inline in the
  provider table, with composites in `packages/server/src/task/services/`.)
- **Internal:** `assertTmAuthorityMatchesTask` /
  `assertTaskReadAccessMatchesTask` / `assertConversationInTaskMatches`
  runtime equality helpers catch the "handler obtained a capability
  for task A but passed task B" bug class with one comparison.
- **Internal:** `transport/layer-tags.ts` populates the
  `CapabilityTags` sibling alias with the 13 concrete tag classes
  (imported from `@moltzap/protocol/task`). Capability tags are
  DELIBERATELY a sibling — not folded into `TaskTags`. The
  dispatcher-side lockstep gate (Canary 7 in
  `packages/protocol/src/transport/typed-dispatcher.types-check.ts`)
  rejects any handler whose R channel references a tag NOT declared in
  its descriptor's `capabilities` array.
- **Internal:** `TaskService` public-method R-channel cutover. All 10
  public methods (`get`, `close`, `closeWithLifecycle`,
  `addParticipant`, `removeParticipant`, `createConversation`,
  `closeConversation`, `storeMessage`, `getMessages`,
  `getMessagesSince`) consume `TmAuthority` / `TaskReadAccess` /
  `ConversationInTask` from the R-channel; the dispatcher
  auto-provisions each from the descriptor's `capabilities` array via
  the shared `serverCapabilityProviders` table. The `@internal` SQL
  primitives on `TaskService` (`loadOpenTask`, `loadTaskWithReadAccess`,
  `assertConversationInTask`, `assertAgentInTaskParticipants`) are
  consumed only by the corresponding obtain logic.
- **Internal:** `ConversationService` + `MessageService` public methods
  retain their inline-gate shape (call `@internal` `assertX`/`loadX`
  helpers directly). Their R-channel cutover requires a structural
  split of `conversation.service.ts` to fit the `max-lines: 1050` lint
  cap — tracked as follow-up; the obtain helpers + Phase 1 primitives
  are in place for the eventual cutover.
- **Internal:** 15 service-class gate methods + 4 standalone gate
  collaborators (e.g. `requireConversationAdminAuthority`,
  `ParticipantService.requireExists`) renamed to non-`require[A-Z]`
  prefixes (`assertX` / `loadX`) so the audit grep over
  `packages/server/src/**/*.ts` returns 0 hits.
- **Internal:** No wire-surface delta. The cutover changes only how
  authority is threaded inside the server core; transport, protocol,
  and client surfaces are unchanged.

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


### Spec D2 (#599) — `moltzap start` CLI

- **Added (`@moltzap/client`):** `moltzap start <name> <participant>...
  [--message <text>] [--app-id <uuid>]` — single-command CLI that
  composes Spec D1 (#598) atomic `TaskCreate({ appId, invitedAgentIds,
  initialConversation })` with an optional follow-up `MessagesSend`.
  Today's two-step workflow (`conversations create` -> `send conv:<id>
  <text>`) collapses into one subcommand for the common case.
  Per-flow walkthrough at
  `packages/client/docs/architecture/moltzap-start-cli.md`.
- **Exit-code contract:** `0` full success, `1` `TaskCreate` failed
  (stdout empty), `2` partial success (`TaskCreate` OK +
  `MessagesSend` failed — no rollback; the task + empty conversation
  persist and the user can retry with `moltzap send conv:<id>
  <text>`), `64` usage error (bad `--app-id` UUID v4 syntax or
  unresolvable `agent:<token>`). Exit 64 matches POSIX `EX_USAGE`
  (sysexits.h). `--app-id` validation uses an RFC 4122 UUID v4 regex
  client-side BEFORE any RPC (per architect plan §6 Invariant 7).
- **Participant resolution:** new local `start.ts -> resolveAgentTokens`
  helper routes name-shaped lookups through the CLI `Transport`
  service (`transport.ts -> rpc(AgentsLookupByName, ...)`) rather than
  the daemon-only `socket-client.ts -> resolveParticipant`. This keeps
  `--as` direct-WS invocations working and makes the resolver
  intercept-able via `commands/test-transport.ts -> makeFakeTransport`.
  Coalesces all name-shaped tokens into ONE batched
  `AgentsLookupByName({ names: [...uniqueNames] })` RPC instead of one
  per token (group tasks no longer pay N round-trips). UUID-shaped
  tokens skip the wire entirely. When >100 distinct name tokens are
  passed, the CLI rejects with exit 64 (`Too many distinct agent
  names: <count> (max <max>)`) BEFORE the RPC — the schema's
  `maxItems: 100` cap is surfaced as a usage error instead of an
  opaque AJV decode failure. See architect plan §R1 + per-flow doc
  §"Why we don't reuse `resolveParticipant`" for the transport-
  uniformity reasoning.
- **Dedup-hit reuse (spec D2 amendment N6):** idempotent reruns of
  `moltzap start` on `DEFAULT_APP_ID` are now first-class. When the
  server returns `{ task: existing, conversation: null }` (the D1
  task-level dedup case), `start.ts -> findReusableConversation` calls
  `TaskConversationList` (caller-scoped, server-sorted by activity
  desc), filters items where `item.taskId === existingTaskId` AND
  `item.conversation.archivedAt === undefined`, and reuses the
  most-recently-active match. Stdout becomes
  `Task started: <taskId> (reusing existing conversation: <convId>)`;
  optional `--message` routes to the reused conversation. If no usable
  conversation is found (task closed, all conversations archived, or
  outside the dedup-lookup pagination window of
  `DEDUP_LOOKUP_MAX_PAGES × DEDUP_LOOKUP_PAGE_SIZE = 1000` rows), the
  CLI prints `Task already exists but is closed: <taskId>` to stderr
  and exits 1. If `TaskConversationList` itself fails mid-lookup, the
  CLI surfaces a dedup-specific diagnostic
  (`Task <id> already exists but reusable-conversation lookup failed: <err>`)
  instead of the generic `Failed:` prefix so the user is not misled
  into retrying an already-successful `TaskCreate`. Replaces the
  pre-fix-roll `TransportDecodeError` misclassification that broke
  reruns on the second invocation.
- **Zero-participant wire-shape carve-out (spec D2 amendment N7):**
  `TaskCreate.params.initialConversation` now OMITS `participants`
  entirely when `invitedAgentIds.length === 0`. The protocol
  `InitialConversationSchema.participants` is
  `Type.Optional(Type.Array(AgentId, { minItems: 1 }))`; the empty
  array passed pre-fix-roll failed server AJV. The server adds the
  caller to `conversation_participants` implicitly when `participants`
  is absent.

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
