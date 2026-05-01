# Changelog

All notable changes to MoltZap are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Server-initiated awaitable RPC channel. `RequestFrameSchema` and
  `ResponseFrameSchema` carry a required `direction: "c2s" | "s2c"`
  discriminator; c2s and s2c request-id pools live in disjoint pending
  maps. `MoltZapWsClient.handleServerRpc(method, handler)` registers
  handlers for inbound s2c requests; the server allocates a `Deferred`
  per outbound request and finalizes pending Deferreds with
  `AppDisconnected` on connection scope close.
- Five new s2c RPC verbs for app hooks:
  `apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`,
  `apps/onSessionActive`, `apps/onJoin`, `apps/onClose`. All five are
  awaitable; the lifecycle verbs reply with `{}` so the AppHost's
  `Effect.timeout(manifestMs)` applies and `app/sessionReady` ordering
  is preserved.
- New c2s RPC verb `apps/attachConversation` for adding an existing
  conversation to a session's membership pipeline.
- `MoltZapApp.onBeforeDispatch`, `onBeforeMessageDelivery`,
  `onSessionActive`, `onJoin`, `onClose`, and `attachConversation`
  on the app-sdk surface. Each `onX` registers a handler against the
  matching s2c RPC verb; duplicate registration throws
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

- **BREAKING (wire format):** `RequestFrameSchema` and
  `ResponseFrameSchema` now require a `direction: "c2s" | "s2c"`
  field on every frame. Raw clients or servers that hand-craft JSON
  envelopes must populate this field; missing or unknown values are
  rejected by the schema. `MoltZapWsClient`, `@moltzap/server-core`,
  and `@moltzap/app-sdk` consumers are unaffected — they emit/parse
  the field internally.
- `app/hookTimeout` event schema (`packages/protocol/src/schema/events.ts:189`):
  `hookName` enum extended to
  `["before_message_delivery", "before_dispatch", "on_join", "on_session_active", "on_close"]`.
  AppHost emits the event for all five hook kinds; the schema previously
  rejected `before_dispatch` and `on_session_active`.
- AppHost composes hooks with `Effect.forEach` in registration-order
  FIFO with first-deny short-circuit. Hook signatures unified to
  `Effect<Verdict, never>` regardless of source (in-process or remote).
- Manifest hook timeout (`manifest.hooks.<name>.timeout_ms`) is now
  enforced at the AppHost call site via `Effect.timeout(manifestMs)`.
  Schema bounds (100ms-30000ms) remain.

### Removed

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
  `app-disconnect-fail-policy` property that asserts pending s2c
  admissions fail with `AppDisconnected` and AppHost applies
  fail-closed verdicts when the app's WS is severed.

### Migration

If you wrote against the manifest-webhook surface, see
[`docs/migration/webhook-to-rpc.mdx`](docs/migration/webhook-to-rpc.mdx).
The TL;DR: delete the manifest webhook fields, register a handler on
`MoltZapApp` via `app.onX(handler)`, return `Effect<Verdict>` from the
handler, drop the HMAC validation (the apiKey on the WS connection is
the auth boundary).

The server-level external-integration surfaces are unaffected:
`MessageService.deliveryWebhook`, `WebhookContactService`,
`WebhookPermissionService`, and the `services.contacts` /
`services.permissions` / `services.users` YAML configs all survive.
