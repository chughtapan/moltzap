# Service surface migration checklist (arch-G)

Scope: every existing server-side service whose public surface returns
`Promise<T>` or throws. Arch-G does not migrate these here — the list is
the contract that `implement-senior` consumes to sequence the Promise→Effect
conversion across slices. Ordering and cross-service coordination are the
implementer's call; this file names the target shapes so they cannot drift.

Hard rules (spec + arch-G hard constraints):

1. No `Promise<T>` on a public signature. Every public function returns
   `Effect<T, E, R>` where `E` is a named error tag or a discriminated
   union and `R` is the service's Context requirement (or `never`).
2. No thrown exceptions on the success path. Thrown errors reserved for
   unrecoverable defects (OOM, corrupted invariants); those collapse to
   `InternalError` at the router edge.
3. No `any`, no `Record<string, unknown>` on public signatures.
4. Each service's error channel is closed. Where today a service throws a
   mix of `RpcFailure` and unchecked errors, the target shape names every
   tag.
5. No dual-path services. When a service migrates, the old shape is
   removed in the same PR; callers update in the same PR. (Spec clean-break
   constraint; no shims.)

Each row's `Target shape` is the public surface after migration. The
`Error channel` column is the closed union the caller must match on. The
`Touchpoints` column points at callers that change in the same PR — the
implementer uses this to size the slice.

Services already Effect-shaped (`AuthService`, `ConversationService`,
`ParticipantService`, `DeliveryService`, `MessageService`) are listed so
their Context requirements get formalized under the arch-G layer split
(`TaskLayerLive` inputs) — none stay as ad-hoc class constructors with
positional `Db` / `Broadcaster` / `AppHost` arguments.

---

## Services in scope

### 1. `AuthService` — `packages/server/src/services/auth.service.ts`

- Current shape: `Effect<T, never>` on most methods; `registerAgent` is
  closure-captured over `Db`, not resolved from Context.
- Target shape: same per-method Effects, exposed via `AuthServiceTag`;
  constructor replaced by `Layer.effect(AuthServiceTag, …)`.
- Error channel: `never` (where correct) or tagged `AuthError` union.
- Touchpoints: `auth/register`, `auth/claim`, `auth/connect` handlers.

### 2. `ParticipantService` — `packages/server/src/services/participant.service.ts`

- Current shape: `Effect<T, RpcFailure>` with Db closed over.
- Target shape: unchanged methods; resolved via `ParticipantServiceTag`.
  `RpcFailure` stays as the typed failure channel.
- Error channel: `RpcFailure` (closed — see `runtime/errors.ts`).
- Touchpoints: every handler under `app/handlers/` that validates agent IDs.

### 3. `ConversationService` — `packages/server/src/services/conversation.service.ts`

- Current shape: `Effect<T, RpcFailure>` with Db + ParticipantService +
  ConnectionManager closed over in the constructor; plus an
  `isAttachedToActiveSession` callback closure.
- Target shape: resolved via `ConversationServiceTag`; closure-captured
  callback replaced by yielding `AppHostTag` (task-layer context only) at
  the one call site that needs it. `ConnectionManagerTag` yielded at the
  subscribe-agents-to-conversation site instead of being held.
- Error channel: `RpcFailure`.
- Touchpoints: `conversations/*` handlers, `ConversationService.create`.

### 4. `DeliveryService` (task-shaped) — `packages/server/src/services/delivery.service.ts`

- NOTE: This is the per-message tracking service, distinct from the
  network-layer `DeliveryService` in `network/delivery-service.ts`
  (arch-G module 2). The task-shaped service is renamed.
- Rename to `MessageDeliveryTracker` (or move under `task/`) in
  implement-* to disambiguate from the network primitive. `DeliveryError`
  shadowing also resolved.
- Target shape: `Effect<T, RpcFailure>` resolved via
  `MessageDeliveryTrackerTag`.
- Error channel: `RpcFailure`.
- Touchpoints: `MessageService.send` delivery recording.

### 5. `PresenceService` — `packages/server/src/services/presence.service.ts`

- Current shape: synchronous, mutable `Map`-backed class. Every method is
  `void` or returns a value directly; no Effect wrapping at all.
- Target shape: all writes return `Effect.Effect<void, never, never>`
  (writes must be sequenced via the runtime to interact correctly with the
  new subscribe-notify fanout). Reads stay synchronous where they are
  pure map reads; async-observable ones return `Effect`.
- Error channel: `never` (in-memory) — subscription push returns
  `Effect<void, DeliveryError, ConnectionManagerTag | DeliveryServiceTag>`
  once the push path moves through `DeliveryService.send`.
- Touchpoints: `presence/update`, `presence/subscribe`, the connection
  teardown hook in the WS router.

### 6. `MessageService` — `packages/server/src/services/message.service.ts`

- Current shape: `Effect<…, RpcFailure>` with `Broadcaster` closed over
  alongside Db, ConversationService, DeliveryService, AppHost,
  DeliveryWebhookConfig, WebhookClient. Uses `Broadcaster.broadcastToConversation`
  for fan-out.
- Target shape: constructor eliminated; resolved via `MessageServiceTag`.
  Fan-out switches from `Broadcaster.broadcastToConversation` to
  `Effect.forEach(participants, (to) => DeliveryService.send(to, frame))`
  (spec Invariant 6; arch-G modules 1–2). Delivery webhook fire-and-forget
  fibers stay but get a named scope (no more untracked `Effect.runFork`).
- Error channel: `RpcFailure` on the success path; delivery errors
  collapsed into the existing webhook-failure logging path.
- Touchpoints: `messages/send` handler, `AppHost` hook dispatch, the two
  tests under `__tests__/` that currently assert broadcaster behavior.

### 7. `UserService` (`WebhookUserService` + `NullUserService`) — `packages/server/src/services/user.service.ts`

- Current shape: `Effect<…, never>` surface already; `WebhookUserService`
  closes over `WebhookClient` + `Logger`.
- Target shape: resolved via `UserServiceTag` (union of
  `UserService | null` kept — `null` is a first-class configured state).
  `WebhookClient` resolved via `WebhookClientTag`.
- Error channel: `never` externally; internal webhook decode failures
  collapse to `{valid: false}` (current behavior preserved).
- Touchpoints: `auth/connect`, contact-check-seeded operations.

### 8. `AppHost` — `packages/server/src/app/app-host.ts`

- Current shape: mixed `Effect<…, RpcFailure>` and `Effect<…, never>` APIs
  with `Db`, `Broadcaster`, `ConnectionManager`, `UserService`,
  `WebhookClient`, and a `Ref<HashMap<string, Deferred<string[], Error>>>`
  all closed over the constructor.
- Target shape: resolved via `AppHostTag`; broadcaster dependency REMOVED
  (the app-layer `humanContact` prompts fan out via
  `DeliveryService.send`); pending-permissions `Ref` stays (moves under
  `HumanContactTag` in the humanContact refactor — arch-B/C scope).
- Error channel: existing `RpcFailure` + `HookTimeout` + `HookExecutionError`.
  Must close the union explicitly; a named `AppHostError` collects them.
- Touchpoints: `apps/*` handlers, the permission-grant flow, and every
  hook-dispatch call site.

### 9. `DefaultPermissionService` — inside `packages/server/src/app/app-host.ts`

- Current shape: class with `requestPermission(params): Effect<string[], Error>`
  that closes over `Broadcaster`.
- Target shape: absorbed into the unified `humanContact` abstraction per
  spec Invariant 12. As a standalone service it goes away; implement-*
  removes the class and its tag.
- Error channel: becomes part of `HumanContactError` (closed union on the
  new abstraction).
- Touchpoints: `apps/requestPermission` and every handler that currently
  reaches for `DefaultPermissionServiceTag`.

### 10. `WebhookClient` (adapter) — `packages/server/src/adapters/webhook.ts`

- Current shape: class with methods returning `Effect<T, WebhookError>`
  (already Effect-shaped); `signWebhookPayload` is a pure function.
- Target shape: unchanged public surface; resolved via `WebhookClientTag`.
  `signWebhookPayload` stays a free function.
- Error channel: `WebhookError` (already a closed tag set — see the
  `Data.TaggedError` declarations in `webhook.ts`).
- Touchpoints: `AppHost`, `MessageService` (delivery-webhook path).

### 11. `Broadcaster` — `packages/server/src/ws/broadcaster.ts`

- Current shape: class with `broadcastToConversation` (fan-out + silent
  `Effect.runFork`) and `sendToAgent` (same shape).
- Target shape: **removed**. No replacement service; callers use
  `DeliveryService.send` (arch-G module 2) + `Effect.forEach` for fan-out.
- Error channel: n/a (module deleted).
- Touchpoints: every current caller of `Broadcaster.*` — `MessageService`,
  `AppHost`, `DefaultPermissionService`, `ConversationService.create` (via
  the subscribe-after-create hook), presence push, delivery-ack push.
  Implement-* rewrites each call site to `DeliveryService.send` per the
  fan-out shape. See "Files to remove at implement-* time" in the design
  doc.

### 12. `ConnectionManager` (WS-only) — `packages/server/src/ws/connection.ts`

- Current shape: class with synchronous `add` / `remove` / `get` / `all`
  / `getByAgent` / `subscribeAgentsToConversation` / `entries` / `size`.
- Target shape: **removed**. Replaced by the arch-G
  `ConnectionManager` (module 1) whose endpoint-oriented surface subsumes
  connection tracking as a subset (arch-A's `NetworkConnectionManager`
  read surface + arch-G's `register`/`unregister`/`lookup`/`connectedAgents`).
- Error channel: n/a (module deleted).
- Touchpoints: WS upgrade handler, presence, conversation subscriptions,
  `Broadcaster` callers.

---

## Services NOT migrating in arch-G

- `Logger` — already Context-resolved via `LoggerTag`; no change.
- `Db` (Kysely handle) — already Context-resolved via `DbTag`; no change.
- `EnvelopeEncryption` — already a pure data carrier; no change.
- Everything under `packages/app-sdk/` — SDK-side, not server-side. Arch-G
  is server-only.

---

## Open-questions bucket (routed to implement-senior)

1. **`AppHost` internal state (`Ref<HashMap<..., Deferred>>`)** — moves to
   a dedicated `HumanContact` service under arch-B/C. If those slices land
   after arch-G's implement-* PRs, the `Ref` stays on `AppHost` as a
   transitional shape. Recommended default: leave the `Ref` on `AppHost`
   during implement-G; migrate when arch-B/C implementer runs.
2. **`PresenceService` subscription push path** — currently re-derives
   connection subscribers on every push. Under arch-G the push goes
   through `DeliveryService.send`, which resolves via
   `AgentEndpointResolver`. Recommended default: keep the existing
   subscriber-set Map in `PresenceService`; just reroute the push call to
   `send`. Larger presence redesign is out of scope.
3. **`MessageDeliveryTracker` (renamed `DeliveryService`) — should this
   move under `task/services/` per the arch-A target layout, or stay under
   `services/`?** Recommended default: `task/services/` to collocate with
   `MessageService`; aligns with arch-A implement-* move plan.
4. **`WebhookUserService` retry + concurrency** — today closes over
   `WebhookClient.call` with no explicit timeout management. Recommended
   default: no behavior change in implement-G; surface is Effect-shaped
   already, and the webhook retry budget is a separate concern.

Each default is non-load-bearing: the implement-senior may pick any of
the alternatives without returning to arch-G. The recommendations exist so
the first slice can make forward progress without deadlocking on choices.
