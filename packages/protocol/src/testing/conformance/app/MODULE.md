# protocol/testing/conformance/app

_`packages/protocol/src/testing/conformance/app`_

## Purpose

Public barrel for app-layer conformance properties.

App-layer conformance properties.

Dispatch / lease / app-callback invariants — the 14
`dispatch-admission` properties (request / authorize / release /
dispatch-lease-consumed / dispatch-lease-expired / dispatch-lease-get / slow-first
/ same-conv-busy / release-for-one-lease) plus app-disconnect
fail-policy and idempotence.

Each `register*` lives in its own file. The `dispatch-admission`
properties draw on the cross-impl driver in `app/_driver.ts`.

## Public surface

### [`ABANDON_OBSERVATION_BUFFER_MS`](./_helpers.ts#L25)

_Variable_

```ts
export const ABANDON_OBSERVATION_BUFFER_MS = 1_000
```

Provides the abandon observation buffer ms runtime value.

### [`ABANDON_POLL_EXTRA_MS`](./_helpers.ts#L35)

_Variable_

```ts
export const ABANDON_POLL_EXTRA_MS = 2_000
```

Provides the abandon poll extra ms runtime value.

### [`APP_PROPERTIES`](./index.ts#L59)

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
  registerDispatchLeaseConsumedFiresOnFirstSend,
  registerDispatchLeaseConsumedSuppressedOnSecondSend,
  registerDispatchLeaseExpiredFiresOnTtl,
  registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl,
  registerDispatchLeaseGetModeratorSeesRecord,
  registerSameConversationDispatchRequestBusy,
  registerSlowFirstDoesNotDelaySecondAck,
  registerReleaseForOneLeaseDoesNotWaitOnAnother,
  registerAppDisconnectFailPolicy,
  registerIdempotence,
]
```

All app-layer property registrars: dispatch-admission registrars first,
then the cross-category registrars (boundary unavailable,
rpc-semantics idempotence).

### [`ConsumedFrameView`](./_helpers.ts#L91)

_Interface_

```ts
export interface ConsumedFrameView {
  readonly messageId: string;
  readonly leaseId: string;
}
```

Describes consumed frame view.

### [`DISPATCH_ADMISSION_CATEGORY`](./_helpers.ts#L16)

_Variable_

```ts
export const DISPATCH_ADMISSION_CATEGORY = "dispatch-admission"
```

Provides the dispatch admission category runtime value.

### [`dispatchAdmissionViolation`](./_helpers.ts#L68)

_Function_

```ts
export function dispatchAdmissionViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

Executes the dispatch admission violation operation.

**Returns:** The dispatch admission violation result.

### [`DispatchTestDriver`](./_driver.ts#L277)

_Interface_

```ts
export interface DispatchTestDriver {
  readonly recipient: RecipientHandle;
  readonly moderator: ModeratorHandle;
  readonly fixtures: {
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
  };

  /**
   * Spin up an additional recipient client under a fresh agent identity.
   * Used by `same-conversation-second-dispatch-returns-busy` (two recipients
   * in the same conversation issue `agent/dispatch/request` concurrently).
   */
  readonly addRecipient: (opts: {
    readonly agentName?: string;
  }) => Effect.Effect<RecipientHandle, PropertyFailure, Scope.Scope>;

  /** Creates another app-bound conversation for the existing recipient. */
  readonly createConversation: () => Effect.Effect<
    Schema.Schema.Type<typeof conversationIdSchema>,
    PropertyFailure
  >;

  /**
   * Poll `app/dispatch/lease/get` until the lease reaches `expected` or the
   * bound elapses. Returns the final record. Used by every property
   * that asserts a state transition (PENDING→GRANTED, GRANTED→EXPIRED,
   * CLAIMED→CONSUMED, etc.). Implementation polls every 25 ms; bound
   * defaults to 5 s.
   */
  readonly assertLeaseState: (
    dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
    expected: LeaseState,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<void, PropertyFailure>;

  /**
   * Sleep `durationMs` against the real clock to let server-side TTLs elapse.
   * Property authors call this for `dispatch-lease-expired-fires-on-ttl` and the
   * moderator-response timeout property, which both run against a live server.
   */
  readonly advanceTime: (durationMs: number) => Effect.Effect<void>;
}
```

Cross-impl driver. One `DispatchTestDriver` instance per property,
acquired under the property's `Scope`. Wires up the real server,
recipient + moderator clients, and the shared conversation fixture.

### [`DispatchVerdict`](./_driver.ts#L84)

_TypeAlias_

```ts
export type DispatchVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
```

Closed verdict union mirroring the wire `DispatchAdmissionDecisionSchema`.
Properties that need to script a moderator's reply pass a
`DispatchVerdict` value to `recipient.expectAuthorize` /
`respondWith`; the driver encodes it to the wire shape internally.

### [`FAST_ACK_THRESHOLD_MS`](./_helpers.ts#L51)

_Variable_

```ts
export const FAST_ACK_THRESHOLD_MS = 1_000
```

Provides the fast ack threshold ms runtime value.

### [`FORBIDDEN_ERROR_TAG`](./_helpers.ts#L29)

_Variable_

```ts
export const FORBIDDEN_ERROR_TAG = "Forbidden"
```

Provides the forbidden error tag runtime value.

### [`freshMessageId`](./_helpers.ts#L100)

_Function_

```ts
export function freshMessageId(): Schema.Schema.Type<typeof messageId>
```

Executes the fresh message id operation.

**Returns:** The fresh message id result.

### [`HOLD_DRAIN_BUFFER_MS`](./_helpers.ts#L60)

_Variable_

```ts
export const HOLD_DRAIN_BUFFER_MS = 2_000
```

Provides the hold drain buffer ms runtime value.

### [`HOLD_RELEASE_MARGIN_MS`](./_helpers.ts#L56)

_Variable_

```ts
export const HOLD_RELEASE_MARGIN_MS = 500
```

Provides the hold release margin ms runtime value.

### [`isUuidV4`](./_helpers.ts#L114)

_Function_

```ts
export function isUuidV4(s: string): boolean
```

Checks whether uuid v4.

**Returns:** Whether uuid v4.

### [`LeaseIdOnlyView`](./_helpers.ts#L87)

_Interface_

```ts
export interface LeaseIdOnlyView {
  readonly leaseId: string;
}
```

Describes lease id only view.

### [`LeaseState`](./_driver.ts#L95)

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

Closed lease-state union mirroring `LeaseStateSchema`. The driver's
`assertLeaseState` polls `app/dispatch/lease/get` until the registry settles
to the named state or the bound elapses (the bound is per-property;
default 5 s).

### [`makeDispatchTestDriver`](./_driver.ts#L964)

_Function_

```ts
export function makeDispatchTestDriver(
  ctx: ConformanceRunContext,
  config?: { readonly moderatorTimeoutMs?: number },
): Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope>
```

Acquire a fully-wired driver under the surrounding `Scope`. Releases
close every lifecycle client + drop the connected app registration.

Property authors call this from inside their property body; the driver
is per-property, never shared. Cross-property state leakage is the
exact failure mode the per-property scope prevents.

**Returns:** The created dispatch test driver.

### [`MISSING_TOPOLOGY_REASON`](./app-disconnect-fail-policy.ts#L40)

_Variable_

```ts
export const MISSING_TOPOLOGY_REASON =
  "conformance fixture does not bootstrap the app-topology dispatch precondition"
```

Reason this property reports as unavailable. The suite's allowed
coverage-gap table matches on this text, so both sides read one constant.

### [`ModeratorHandle`](./_driver.ts#L206)

_Interface_

```ts
export interface ModeratorHandle {
  readonly agentId: Schema.Schema.Type<typeof agentId>;
  readonly appId: Schema.Schema.Type<typeof appIdSchema>;

  /**
   * Park until a `app/dispatch/authorize` S→C request arrives that matches
   * `predicate` (default: any), then reply with `respondWith`. Internally
   * uses `AppTestClient.onAppCallback` to register the reply and
   * `awaitServerRequest` to observe the params.
   *
   * `holdResponseFor` is for the timeout-synthesizes-deny property:
   * delaying the reply past the moderator-response TTL forces the server
   * into the synthesized-deny branch. Default: reply immediately.
   */
  readonly handleAuthorize: (opts: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
      readonly messageId: Schema.Schema.Type<typeof messageId>;
    }) => boolean;
    readonly holdResponseFor?: number;
  }) => Effect.Effect<void, PropertyFailure>;

  /**
   * Drop the next inbound `app/dispatch/authorize` S→C request — install no
   * handler. Forces moderator-response TTL elapse. Used by
   * `dispatch-authorize-timeout-synthesizes-deny`.
   */
  readonly silenceAuthorize: Effect.Effect<void, PropertyFailure>;

  /**
   * Park until a `app/dispatch/lease-consumed` or `app/dispatch/lease-expired`
   * notification arrives matching `kind` and (optionally) `dispatchId`.
   */
  readonly waitForObservability: <K extends "consumed" | "expired">(
    kind: K,
    opts: {
      readonly dispatchId?: Schema.Schema.Type<typeof dispatchIdSchema>;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<
    K extends "consumed"
      ? NotificationDelivery<typeof dispatchLeaseConsumed>
      : NotificationDelivery<typeof dispatchLeaseExpired>,
    PropertyFailure
  >;

  /**
   * Issue `app/dispatch/lease/get` from the moderator's connection. Used by the
   * positive `dispatch-lease-get-moderator-sees-record` property + every
   * `assertLeaseState` poll.
   */
  readonly getLease: (
    dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
  ) => Effect.Effect<
    {
      readonly state: LeaseState;
      readonly verdict: DispatchVerdict | null;
      readonly leaseId: Schema.Schema.Type<typeof leaseId>;
    },
    PropertyFailure
  >;
}
```

Moderator-side surface. Owns one `AppTestClient` connected to the real
server under a moderator app identity, with HTTP registration plus
`app/network/connect` already driven to install a `dispatch_authorize` hook. Holds
the registered `appId` for `app/dispatch/lease/get` scope assertions.

### [`NEGATIVE_OBSERVABILITY_WINDOW_MS`](./_helpers.ts#L27)

_Variable_

```ts
export const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750
```

Provides the negative observability window ms runtime value.

### [`NO_SECOND_RELEASE_WINDOW_MS`](./_helpers.ts#L46)

_Variable_

```ts
export const NO_SECOND_RELEASE_WINDOW_MS = 250
```

Provides the no second release window ms runtime value.

### [`RecipientHandle`](./_driver.ts#L119)

_Interface_

```ts
export interface RecipientHandle {
  readonly agentId: Schema.Schema.Type<typeof agentId>;

  /**
   * Issue `agent/dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
    readonly messageId: Schema.Schema.Type<typeof messageId>;
    readonly senderAgentId: Schema.Schema.Type<typeof agentId>;
    readonly attempt?: number;
  }) => Effect.Effect<DispatchLeaseAck, PropertyFailure>;

  /**
   * Issue `agent/dispatch/request` without narrowing its declared result union.
   * The busy conformance property uses this surface to observe the no-lease
   * outcome; lease lifecycle properties use `requestDispatch` above.
   */
  readonly requestDispatchOutcome: (params: {
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
    readonly messageId: Schema.Schema.Type<typeof messageId>;
    readonly senderAgentId: Schema.Schema.Type<typeof agentId>;
    readonly attempt?: number;
  }) => Effect.Effect<DispatchRequestOutcome, PropertyFailure>;

  /**
   * Park until a `agent/dispatch/released` notification arrives that matches
   * `predicate` (default: any). Used by every property in the
   * `DispatchRelease` group + every property that asserts a verdict
   * delivery.
   */
  readonly waitForRelease: (
    predicate?: (
      frame: NotificationDelivery<typeof dispatchRelease>,
    ) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    NotificationDelivery<typeof dispatchRelease>,
    PropertyFailure
  >;

  /**
   * Send `agent/message/send` carrying `dispatchLeaseId`. Used to consume a
   * GRANTED lease + assert the consumed/duplicate behavior. Returns the
   * minted message id on success; on the lease-already-CONSUMED path,
   * fails with a `PropertyInvariantViolation` whose `reason` carries
   * the wire-error code + `LeaseInvalid` data tag the server returned.
   */
  readonly sendWithLease: (params: {
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
    readonly leaseId: Schema.Schema.Type<typeof leaseId>;
    readonly text: string;
  }) => Effect.Effect<SendWithLeaseResult, PropertyFailure>;

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

Recipient-side surface. Owns one `AgentTestClient` connected to the real
server under a recipient agent identity. All methods return Effects
scoped to the surrounding `Scope`; releasing the scope closes the
underlying agent client.

### [`registerAppDisconnectFailPolicy`](./app-disconnect-fail-policy.ts#L54)

_Function_

```ts
export function registerAppDisconnectFailPolicy(
  ctx: ConformanceRunContext,
): void
```

Registers app disconnect fail policy.

### [`registerDispatchAuthorizeTimeoutSynthesizesDeny`](./dispatch-authorize-timeout.ts#L18)

_Function_

```ts
export function registerDispatchAuthorizeTimeoutSynthesizesDeny(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch authorize timeout synthesizes deny.

### [`registerDispatchAuthorizeVerdictResolves`](./dispatch-authorize-verdict.ts#L28)

_Function_

```ts
export function registerDispatchAuthorizeVerdictResolves(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch authorize verdict resolves.

### [`registerDispatchLeaseConsumedFiresOnFirstSend`](./dispatch-lease-consumed-fires-on-first-send.ts#L20)

_Function_

```ts
export function registerDispatchLeaseConsumedFiresOnFirstSend(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch lease consumed fires on first send.

### [`registerDispatchLeaseConsumedSuppressedOnSecondSend`](./dispatch-lease-consumed-suppressed-on-second.ts#L18)

_Function_

```ts
export function registerDispatchLeaseConsumedSuppressedOnSecondSend(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch lease consumed suppressed on second send.

### [`registerDispatchLeaseExpiredFiresOnTtl`](./dispatch-lease-expired-fires-on-ttl.ts#L18)

_Function_

```ts
export function registerDispatchLeaseExpiredFiresOnTtl(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch lease expired fires on ttl.

### [`registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl`](./dispatch-lease-expired-suppressed-on-consume.ts#L19)

_Function_

```ts
export function registerDispatchLeaseExpiredSuppressedOnConsumeBeforeTtl(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch lease expired suppressed on consume before ttl.

### [`registerDispatchLeaseGetModeratorSeesRecord`](./dispatch-lease-get-moderator-sees.ts#L17)

_Function_

```ts
export function registerDispatchLeaseGetModeratorSeesRecord(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch lease get moderator sees record.

### [`registerDispatchReleaseFiresAfterResolve`](./dispatch-release-after-resolve.ts#L41)

_Function_

```ts
export function registerDispatchReleaseFiresAfterResolve(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch release fires after resolve.

### [`registerDispatchReleaseSkippedOnAbandoned`](./dispatch-release-skipped-on-abandoned.ts#L16)

_Function_

```ts
export function registerDispatchReleaseSkippedOnAbandoned(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch release skipped on abandoned.

### [`registerDispatchRequestAckMintsLease`](./dispatch-request-ack.ts#L16)

_Function_

```ts
export function registerDispatchRequestAckMintsLease(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch request ack mints lease.

### [`registerDispatchRequestRecipientDisconnectAbandons`](./dispatch-request-recipient-disconnect.ts#L16)

_Function_

```ts
export function registerDispatchRequestRecipientDisconnectAbandons(
  ctx: ConformanceRunContext,
): void
```

Registers dispatch request recipient disconnect abandons.

### [`registerIdempotence`](./idempotence.ts#L55)

_Function_

```ts
export function registerIdempotence(ctx: ConformanceRunContext): void
```

Registers idempotence.

### [`registerReleaseForOneLeaseDoesNotWaitOnAnother`](./release-for-one-lease-does-not-wait.ts#L21)

_Function_

```ts
export function registerReleaseForOneLeaseDoesNotWaitOnAnother(
  ctx: ConformanceRunContext,
): void
```

Registers release for one lease does not wait on another.

### [`registerSameConversationDispatchRequestBusy`](./same-conv-dispatch-request-busy.ts#L17)

_Function_

```ts
export function registerSameConversationDispatchRequestBusy(
  ctx: ConformanceRunContext,
): void
```

Registers the one-live-dispatch-per-conversation property.

### [`registerSlowFirstDoesNotDelaySecondAck`](./slow-first-does-not-delay-second-ack.ts#L16)

_Function_

```ts
export function registerSlowFirstDoesNotDelaySecondAck(
  ctx: ConformanceRunContext,
): void
```

Registers slow first does not delay second ack.

### [`ReleaseFrameView`](./_helpers.ts#L82)

_Interface_

```ts
export interface ReleaseFrameView {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
}
```

Describes release frame view.

### [`SHORT_LEASE_TIMEOUT_MS`](./_helpers.ts#L19)

_Variable_

```ts
export const SHORT_LEASE_TIMEOUT_MS = 250
```

Provides the short lease timeout ms runtime value.

### [`TIMEOUT_RELEASE_WAIT_MS`](./_helpers.ts#L41)

_Variable_

```ts
export const TIMEOUT_RELEASE_WAIT_MS = 3_000
```

Provides the timeout release wait ms runtime value.

### [`TINY_MODERATOR_TIMEOUT_MS`](./_helpers.ts#L21)

_Variable_

```ts
export const TINY_MODERATOR_TIMEOUT_MS = 200
```

Provides the tiny moderator timeout ms runtime value.

### [`TTL_OBSERVATION_BUFFER_MS`](./_helpers.ts#L23)

_Variable_

```ts
export const TTL_OBSERVATION_BUFFER_MS = 1_500
```

Provides the ttl observation buffer ms runtime value.

### [`withDriver`](./_helpers.ts#L126)

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

**Returns:** The with driver result.

## Files

- `_driver.ts`
- `_helpers.ts`
- `app-disconnect-fail-policy.ts`
- `dispatch-authorize-timeout.ts`
- `dispatch-authorize-verdict.ts`
- `dispatch-lease-consumed-fires-on-first-send.ts`
- `dispatch-lease-consumed-suppressed-on-second.ts`
- `dispatch-lease-expired-fires-on-ttl.ts`
- `dispatch-lease-expired-suppressed-on-consume.ts`
- `dispatch-lease-get-moderator-sees.ts`
- `dispatch-release-after-resolve.ts`
- `dispatch-release-skipped-on-abandoned.ts`
- `dispatch-request-ack.ts`
- `dispatch-request-recipient-disconnect.ts`
- `idempotence.ts`
- `index.ts`
- `release-for-one-lease-does-not-wait.ts`
- `same-conv-dispatch-request-busy.ts`
- `slow-first-does-not-delay-second-ack.ts`
