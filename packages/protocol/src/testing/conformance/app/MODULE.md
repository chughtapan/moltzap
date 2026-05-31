# protocol/testing/conformance/app

_`packages/protocol/src/testing/conformance/app`_

## Purpose

Public barrel for app-layer conformance properties.

App-layer conformance properties.

Dispatch / lease / app-callback invariants — the 15
`dispatch-admission` properties (request / authorize / release /
dispatches-consumed / dispatches-expired / dispatches-get / slow-first
/ same-conv-concurrent / release-for-one-lease) plus app-disconnect
fail-policy, hook-gated delivery, multi-app FIFO (tombstone), spurious
app-callback frame handling (tombstone), and idempotence.

Each `register*` lives in its own file. The `dispatch-admission`
properties draw on the cross-impl driver in `app/_driver.ts`.

## Public surface

### [`ABANDON_OBSERVATION_BUFFER_MS`](./_helpers.ts#L20)

_Variable_

```ts
export const ABANDON_OBSERVATION_BUFFER_MS = 1_000
```

### [`ABANDON_POLL_EXTRA_MS`](./_helpers.ts#L27)

_Variable_

```ts
export const ABANDON_POLL_EXTRA_MS = 2_000
```

### [`APP_PROPERTIES`](./index.ts#L68)

_Variable_

```ts
export const APP_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [
  registerDispatchRequestAckMintsLease,
  registerDispatchRequestRecipientDisconnectAbandons,
  registerDispatchAuthorizeVerdictResolves,
  registerDispatchAuthorizeTimeoutSynthesizesDeny,
  registerDispatchReleaseFiresAfterResolve,
  registerDispatchReleaseSkippedOnAbandoned,
  registerDispatchesConsumedFiresOnFirstSend,
  registerDispatchesConsumedSuppressedOnSecondSend,
  registerDispatchesExpiredFiresOnTtl,
  registerDispatchesExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchesGetModeratorSeesRecord,
  registerDispatchesGetNonModeratorRejected,
  registerSameConversationDispatchesConcurrent,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerHookGatedDelivery,
  registerMultiAppFifoShortCircuit,
  registerAppDisconnectFailPolicy,
  registerSpuriousAppCallbackFrameHandling,
  registerIdempotence,
]
```

All app-layer property registrars: 15 dispatch-admission registrars
first, then the 5 cross-category registrars (delivery tombstones,
boundary unavailable, rpc-semantics spurious-callback tombstone,
rpc-semantics idempotence).

### [`ConsumedFrameView`](./_helpers.ts#L67)

_TypeAlias_

```ts
export type ConsumedFrameView = {
  readonly messageId: string;
  readonly leaseId: string;
};
```

### [`DISPATCH_ADMISSION_CATEGORY`](./_helpers.ts#L15)

_Variable_

```ts
export const DISPATCH_ADMISSION_CATEGORY = "dispatch-admission" as const
```

### [`dispatchAdmissionViolation`](./_helpers.ts#L49)

_Function_

```ts
export function dispatchAdmissionViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`DispatchTestDriver`](./_driver.ts#L265)

_Interface_

```ts
export interface DispatchTestDriver {
  readonly recipient: RecipientHandle;
  readonly moderator: ModeratorHandle;
  readonly fixtures: {
    readonly taskId: Schema.Schema.Type<typeof TaskId>;
    readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
  };

  /**
   * Spin up an additional recipient client under a fresh agent identity.
   * Used by `same-conversation-dispatches-reach-moderator-concurrently`
   * (two recipients in the same conversation issue `dispatch/request`
   * back-to-back).
   */
  readonly addRecipient: (opts: {
    readonly agentName?: string;
  }) => Effect.Effect<RecipientHandle, PropertyFailure, Scope.Scope>;

  /**
   * Issue `dispatches/get` from a NON-moderator connection (the
   * recipient or a third-party client). Used by the negative scope
   * property `dispatches-get-non-moderator-rejected`. Returns the
   * server's typed error rather than the lease record.
   */
  readonly getLeaseFromNonModerator: (
    dispatchId: Schema.Schema.Type<typeof DispatchId>,
  ) => Effect.Effect<{ readonly errorCode: number }, PropertyFailure>;

  /**
   * Poll `dispatches/get` until the lease reaches `expected` or the
   * bound elapses. Returns the final record. Used by every property
   * that asserts a state transition (PENDING→GRANTED, GRANTED→EXPIRED,
   * CLAIMED→CONSUMED, etc.). Implementation polls every 25 ms; bound
   * defaults to 5 s.
   */
  readonly assertLeaseState: (
    dispatchId: Schema.Schema.Type<typeof DispatchId>,
    expected: LeaseState,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<void, PropertyFailure>;

  /**
   * Advance the test clock by `durationMs`. If the conformance harness
   * is running against `TestClock`, this fast-forwards TTLs; otherwise
   * (real-time mode) it is a `Effect.sleep`. Property authors call this
   * for `dispatches-expired-fires-on-ttl` and the moderator-response
   * timeout property.
   */
  readonly advanceTime: (durationMs: number) => Effect.Effect<void>;
}
```

Cross-impl driver. One `DispatchTestDriver` instance per property,
acquired under the property's `Scope`. Wires up the real server,
recipient + moderator clients, and shared task / conversation
fixtures.

### [`DispatchTestDriverConfig`](./_driver.ts#L329)

_Interface_

```ts
export interface DispatchTestDriverConfig {
  readonly taskAppId?: string | null;
  readonly moderatorTimeoutMs?: number;
  readonly leaseTimeoutMs?: number;
}
```

Driver options. `taskAppId` controls whether the server-side path is
app-bound (moderated, default) or default-grant. Default: app-bound
via `taskAppId: "conformance-test-app"`. The `default-grant` properties
(none today; reserved for future) pass `taskAppId: null`.

`moderatorTimeoutMs` is propagated to the manifest's
`hooks.dispatch_authorize.timeout_ms`. Properties that exercise the
moderator-response TTL pass a small value (e.g., 200 ms); properties
that don't care pass the default 5_000 ms.

### [`DispatchVerdict`](./_driver.ts#L88)

_TypeAlias_

```ts
export type DispatchVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
```

Closed verdict union mirroring the wire `DispatchAdmissionDecisionSchema`.
Properties that need to script a moderator's reply pass a
`DispatchVerdict` value to `recipient.expectAuthorize` /
`respondWith`; the driver encodes it to the wire shape internally.

### [`FAST_ACK_THRESHOLD_MS`](./_helpers.ts#L40)

_Variable_

```ts
export const FAST_ACK_THRESHOLD_MS = 1_000
```

### [`FORBIDDEN_ERROR_CODE`](./_helpers.ts#L22)

_Variable_

```ts
export const FORBIDDEN_ERROR_CODE = -32001
```

### [`freshMessageId`](./_helpers.ts#L72)

_Function_

```ts
export function freshMessageId(): Schema.Schema.Type<typeof MessageId>
```

### [`HOLD_DRAIN_BUFFER_MS`](./_helpers.ts#L47)

_Variable_

```ts
export const HOLD_DRAIN_BUFFER_MS = 2_000
```

### [`HOLD_RELEASE_MARGIN_MS`](./_helpers.ts#L44)

_Variable_

```ts
export const HOLD_RELEASE_MARGIN_MS = 500
```

### [`isUuidV4`](./_helpers.ts#L81)

_Function_

```ts
export function isUuidV4(s: string): boolean
```

### [`leaseId`](./_helpers.ts#L69)

_Property_

```ts
  readonly leaseId: string;
};

export function freshMessageId(): Schema.Schema.Type<typeof MessageId> {
```

### [`leaseId`](./_helpers.ts#L66)

_Property_

```ts
export type LeaseIdOnlyView = { readonly leaseId: string };
```

### [`leaseId`](./_helpers.ts#L63)

_Property_

```ts
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
```

### [`LeaseIdOnlyView`](./_helpers.ts#L66)

_TypeAlias_

```ts
export type LeaseIdOnlyView = { readonly leaseId: string };
```

### [`LeaseState`](./_driver.ts#L99)

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

// ── Recipient handle ──────────────────────────────────────────────────

/**
 * Recipient-side surface. Owns one TestClient connected to the real
 * server under a recipient agent identity. All methods return Effects
 * scoped to the surrounding `Scope`; releasing the scope closes the
 * underlying TestClient.
 */
export interface RecipientHandle {
  readonly agentId: Schema.Schema.Type<typeof AgentId>;

  /**
   * Issue `dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
    readonly messageId: Schema.Schema.Type<typeof MessageId>;
    readonly senderAgentId: Schema.Schema.Type<typeof AgentId>;
    readonly attempt?: number;
  }) => Effect.Effect<
    {
      readonly leaseId: Schema.Schema.Type<typeof LeaseId>;
      readonly dispatchId: Schema.Schema.Type<typeof DispatchId>;
    },
    PropertyFailure
  >;

  /**
   * Park until a `dispatch/release` notification arrives that matches
   * `predicate` (default: any). Used by every property in the
   * `DispatchRelease` group + every property that asserts a verdict
   * delivery.
   */
  readonly waitForRelease: (
    predicate?: (frame: DecodedNotification<typeof DispatchRelease>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    DecodedNotification<typeof DispatchRelease>,
    PropertyFailure
  >;

  /**
   * Send `messages/send` carrying `dispatchLeaseId`. Used to consume a
   * GRANTED lease + assert the consumed/duplicate behavior. Returns the
   * minted message id on success; on the lease-already-CONSUMED path,
   * fails with a `PropertyInvariantViolation` whose `reason` carries
   * the wire-error code + `LeaseInvalid` data tag the server returned.
   */
  readonly sendWithLease: (params: {
    readonly taskId: Schema.Schema.Type<typeof TaskId>;
    readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
    readonly leaseId: Schema.Schema.Type<typeof LeaseId>;
    readonly text: string;
  }) => Effect.Effect<
    {
      readonly messageId: Schema.Schema.Type<typeof MessageId>;
      readonly errorCode?: number;
      readonly errorState?: string;
    },
    PropertyFailure
  >;

  /**
   * Disconnect the recipient's WS without graceful shutdown.
   * Drives ABANDONED + EXPIRED-on-disconnect transitions for every
   * `*-disconnect-*` property. The returned Effect resolves once the
   * server has observed the close (registry's connection-close
   * finalizer fired).
   */
  readonly hardClose: Effect.Effect<void, PropertyFailure>;
}
```

Closed lease-state union mirroring `LeaseStateSchema`. The driver's
`assertLeaseState` polls `dispatches/get` until the registry settles
to the named state or the bound elapses (the bound is per-property;
default 5 s).

### [`makeDispatchTestDriver`](./_driver.ts#L951)

_Function_

```ts
export function makeDispatchTestDriver(
  ctx: ConformanceRunContext,
  config?: DispatchTestDriverConfig,
): Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope>
```

Acquire a fully-wired driver under the surrounding `Scope`. Releases
close every TestClient + drop the `apps/register` registration.

Property authors call this from inside their property body; the driver
is per-property, never shared. Cross-property state leakage is the
exact failure mode the per-property scope prevents.

### [`messageId`](./_helpers.ts#L68)

_Property_

```ts
  readonly messageId: string;
  readonly leaseId: string;
};

export function freshMessageId(): Schema.Schema.Type<typeof MessageId> {
```

### [`ModeratorHandle`](./_driver.ts#L192)

_Interface_

```ts
export interface ModeratorHandle {
  readonly agentId: Schema.Schema.Type<typeof AgentId>;
  readonly appId: string;

  /**
   * Park until a `dispatch/authorize` S→C request arrives that matches
   * `predicate` (default: any), then reply with `respondWith`. Internally
   * uses `TestClient.onAppCallback` to register the reply and
   * `awaitServerRequest` to observe the params.
   *
   * `holdResponseFor` is for the timeout-synthesizes-deny property:
   * delaying the reply past the moderator-response TTL forces the server
   * into the synthesized-deny branch. Default: reply immediately.
   */
  readonly handleAuthorize: (opts: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly taskId: Schema.Schema.Type<typeof TaskId>;
      readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
      readonly messageId: Schema.Schema.Type<typeof MessageId>;
    }) => boolean;
    readonly holdResponseFor?: number;
  }) => Effect.Effect<void, PropertyFailure>;

  /**
   * Drop the next inbound `dispatch/authorize` S→C request — install no
   * handler. Forces moderator-response TTL elapse. Used by
   * `dispatch-authorize-timeout-synthesizes-deny`.
   */
  readonly silenceAuthorize: Effect.Effect<void, PropertyFailure>;

  /**
   * Park until a `dispatches/consumed` or `dispatches/expired`
   * notification arrives matching `kind` and (optionally) `dispatchId`.
   */
  readonly waitForObservability: <K extends "consumed" | "expired">(
    kind: K,
    opts: {
      readonly dispatchId?: Schema.Schema.Type<typeof DispatchId>;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<
    K extends "consumed"
      ? DecodedNotification<typeof DispatchesConsumed>
      : DecodedNotification<typeof DispatchesExpired>,
    PropertyFailure
  >;

  /**
   * Issue `dispatches/get` from the moderator's connection. Used by the
   * positive `dispatches-get-moderator-sees-record` property + every
   * `assertLeaseState` poll.
   */
  readonly getLease: (
    dispatchId: Schema.Schema.Type<typeof DispatchId>,
  ) => Effect.Effect<
    {
      readonly state: LeaseState;
      readonly verdict: DispatchVerdict | null;
      readonly leaseId: Schema.Schema.Type<typeof LeaseId>;
    },
    PropertyFailure
  >;
}
```

Moderator-side surface. Owns one TestClient connected to the real
server under a moderator agent identity, with `apps/register` already
driven to install a `dispatch_authorize` hook for the test app. Holds
the registered `appId` for `dispatches/get` scope assertions.

### [`NEGATIVE_OBSERVABILITY_WINDOW_MS`](./_helpers.ts#L21)

_Variable_

```ts
export const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750
```

### [`NO_SECOND_RELEASE_WINDOW_MS`](./_helpers.ts#L36)

_Variable_

```ts
export const NO_SECOND_RELEASE_WINDOW_MS = 250
```

### [`RecipientHandle`](./_driver.ts#L117)

_Interface_

```ts
export interface RecipientHandle {
  readonly agentId: Schema.Schema.Type<typeof AgentId>;

  /**
   * Issue `dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
    readonly messageId: Schema.Schema.Type<typeof MessageId>;
    readonly senderAgentId: Schema.Schema.Type<typeof AgentId>;
    readonly attempt?: number;
  }) => Effect.Effect<
    {
      readonly leaseId: Schema.Schema.Type<typeof LeaseId>;
      readonly dispatchId: Schema.Schema.Type<typeof DispatchId>;
    },
    PropertyFailure
  >;

  /**
   * Park until a `dispatch/release` notification arrives that matches
   * `predicate` (default: any). Used by every property in the
   * `DispatchRelease` group + every property that asserts a verdict
   * delivery.
   */
  readonly waitForRelease: (
    predicate?: (frame: DecodedNotification<typeof DispatchRelease>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    DecodedNotification<typeof DispatchRelease>,
    PropertyFailure
  >;

  /**
   * Send `messages/send` carrying `dispatchLeaseId`. Used to consume a
   * GRANTED lease + assert the consumed/duplicate behavior. Returns the
   * minted message id on success; on the lease-already-CONSUMED path,
   * fails with a `PropertyInvariantViolation` whose `reason` carries
   * the wire-error code + `LeaseInvalid` data tag the server returned.
   */
  readonly sendWithLease: (params: {
    readonly taskId: Schema.Schema.Type<typeof TaskId>;
    readonly conversationId: Schema.Schema.Type<typeof ConversationId>;
    readonly leaseId: Schema.Schema.Type<typeof LeaseId>;
    readonly text: string;
  }) => Effect.Effect<
    {
      readonly messageId: Schema.Schema.Type<typeof MessageId>;
      readonly errorCode?: number;
      readonly errorState?: string;
    },
    PropertyFailure
  >;

  /**
   * Disconnect the recipient's WS without graceful shutdown.
   * Drives ABANDONED + EXPIRED-on-disconnect transitions for every
   * `*-disconnect-*` property. The returned Effect resolves once the
   * server has observed the close (registry's connection-close
   * finalizer fired).
   */
  readonly hardClose: Effect.Effect<void, PropertyFailure>;
}
```

Recipient-side surface. Owns one TestClient connected to the real
server under a recipient agent identity. All methods return Effects
scoped to the surrounding `Scope`; releasing the scope closes the
underlying TestClient.

### [`registerAppDisconnectFailPolicy`](./app-disconnect-fail-policy.ts#L45)

_Function_

```ts
export function registerAppDisconnectFailPolicy(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchAuthorizeTimeoutSynthesizesDeny`](./dispatch-authorize-timeout.ts#L14)

_Function_

```ts
export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchAuthorizeVerdictResolves`](./dispatch-authorize-verdict.ts#L24)

_Function_

```ts
export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesConsumedFiresOnFirstSend`](./dispatches-consumed-fires-on-first-send.ts#L14)

_Function_

```ts
export function registerDispatchesConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesConsumedSuppressedOnSecondSend`](./dispatches-consumed-suppressed-on-second.ts#L14)

_Function_

```ts
export function registerDispatchesConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesExpiredFiresOnTtl`](./dispatches-expired-fires-on-ttl.ts#L14)

_Function_

```ts
export function registerDispatchesExpiredFiresOnTtl(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesExpiredSuppressedOnConsumeBeforeTtl`](./dispatches-expired-suppressed-on-consume.ts#L15)

_Function_

```ts
export function registerDispatchesExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesGetModeratorSeesRecord`](./dispatches-get-moderator-sees.ts#L14)

_Function_

```ts
export function registerDispatchesGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchesGetNonModeratorRejected`](./dispatches-get-non-moderator-rejected.ts#L12)

_Function_

```ts
export function registerDispatchesGetNonModeratorRejected(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchReleaseFiresAfterResolve`](./dispatch-release-after-resolve.ts#L33)

_Function_

```ts
export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchReleaseSkippedOnAbandoned`](./dispatch-release-skipped-on-abandoned.ts#L12)

_Function_

```ts
export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchRequestAckMintsLease`](./dispatch-request-ack.ts#L12)

_Function_

```ts
export function registerDispatchRequestAckMintsLease(
  ctx: ConformanceRunContext,
): void
```

### [`registerDispatchRequestRecipientDisconnectAbandons`](./dispatch-request-recipient-disconnect.ts#L12)

_Function_

```ts
export function registerDispatchRequestRecipientDisconnectAbandons(
  ctx: ConformanceRunContext,
): void
```

### [`registerHookGatedDelivery`](./hook-gated-delivery.ts#L18)

_Function_

```ts
export function registerHookGatedDelivery(ctx: ConformanceRunContext): void
```

### [`registerIdempotence`](./idempotence.ts#L55)

_Function_

```ts
export function registerIdempotence(ctx: ConformanceRunContext): void
```

### [`registerMultiAppFifoShortCircuit`](./multi-app-fifo-short-circuit.ts#L16)

_Function_

```ts
export function registerMultiAppFifoShortCircuit(
  ctx: ConformanceRunContext,
): void
```

### [`registerReleaseForOneLeaseDoesNotWaitOnAnother`](./release-for-one-lease-does-not-wait.ts#L17)

_Function_

```ts
export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void
```

### [`registerSameConversationDispatchesConcurrent`](./same-conv-dispatches-concurrent.ts#L14)

_Function_

```ts
export function registerSameConversationDispatchesConcurrent(
  ctx: ConformanceRunContext,
): void
```

### [`registerSlowFirstDoesNotDelaySecondAck`](./slow-first-does-not-delay-second-ack.ts#L12)

_Function_

```ts
export function registerSlowFirstDoesNotDelaySecondAck(
  ctx: ConformanceRunContext,
): void
```

### [`registerSpuriousAppCallbackFrameHandling`](./spurious-app-callback-frame.ts#L27)

_Function_

```ts
export function registerSpuriousAppCallbackFrameHandling(
  ctx: ConformanceRunContext,
): void
```

### [`ReleaseFrameView`](./_helpers.ts#L62)

_TypeAlias_

```ts
export type ReleaseFrameView = {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
};
```

### [`SHORT_LEASE_TIMEOUT_MS`](./_helpers.ts#L17)

_Variable_

```ts
export const SHORT_LEASE_TIMEOUT_MS = 250
```

### [`TIMEOUT_RELEASE_WAIT_MS`](./_helpers.ts#L32)

_Variable_

```ts
export const TIMEOUT_RELEASE_WAIT_MS = 3_000
```

### [`TINY_MODERATOR_TIMEOUT_MS`](./_helpers.ts#L18)

_Variable_

```ts
export const TINY_MODERATOR_TIMEOUT_MS = 200
```

### [`TTL_OBSERVATION_BUFFER_MS`](./_helpers.ts#L19)

_Variable_

```ts
export const TTL_OBSERVATION_BUFFER_MS = 1_500
```

### [`verdict`](./_helpers.ts#L64)

_Property_

```ts
  readonly verdict: { decision: string; reason?: string };
```

### [`withDriver`](./_helpers.ts#L89)

_Function_

```ts
export function withDriver(
  ctx: ConformanceRunContext,
  body: (
    driver: DispatchTestDriver,
  ) => Effect.Effect<void, PropertyFailure, Scope.Scope>,
  driverOpts?: Parameters<typeof makeDispatchTestDriver>[1],
): PropertyRun
```

Run a property body inside a fresh per-property scope; acquires the
driver, runs `body`, releases on completion.

## Files

- `_driver.ts`
- `_helpers.ts`
- `app-disconnect-fail-policy.ts`
- `dispatch-authorize-timeout.ts`
- `dispatch-authorize-verdict.ts`
- `dispatch-release-after-resolve.ts`
- `dispatch-release-skipped-on-abandoned.ts`
- `dispatch-request-ack.ts`
- `dispatch-request-recipient-disconnect.ts`
- `dispatches-consumed-fires-on-first-send.ts`
- `dispatches-consumed-suppressed-on-second.ts`
- `dispatches-expired-fires-on-ttl.ts`
- `dispatches-expired-suppressed-on-consume.ts`
- `dispatches-get-moderator-sees.ts`
- `dispatches-get-non-moderator-rejected.ts`
- `hook-gated-delivery.ts`
- `idempotence.ts`
- `index.ts`
- `multi-app-fifo-short-circuit.ts`
- `release-for-one-lease-does-not-wait.ts`
- `same-conv-dispatches-concurrent.ts`
- `slow-first-does-not-delay-second-ack.ts`
- `spurious-app-callback-frame.ts`
