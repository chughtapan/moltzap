# protocol/testing/conformance/app

_`packages/protocol/src/testing/conformance/app`_

## Purpose

Public barrel for app-layer conformance properties.

App-layer conformance properties.

Dispatch / lease / app-callback invariants — the 15
`dispatch-admission` properties (request / authorize / release /
dispatches-consumed / dispatches-expired / dispatches-get / slow-first
/ same-conv-concurrent / release-for-one-lease) plus app-disconnect
fail-policy, hook-gated delivery (executable since #560), multi-app FIFO
(tombstoned), spurious app-callback frame handling (tombstoned), and
idempotence.

Each `register*` lives in its own file. The per-`dispatch-admission`
properties draw on the cross-impl driver in `app/_driver.ts` (carved
from legacy `conformance/test-server-driver.ts`).

## Public surface

### [`ABANDON_OBSERVATION_BUFFER_MS`](./_helpers.ts#L24)

_Variable_

```ts
export const ABANDON_OBSERVATION_BUFFER_MS = 1_000
```

### [`ABANDON_POLL_EXTRA_MS`](./_helpers.ts#L31)

_Variable_

```ts
export const ABANDON_POLL_EXTRA_MS = 2_000
```

### [`APP_PROPERTIES`](./index.ts#L70)

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

All app-layer property registrars, ordered per architect plan §2:
15 dispatch-admission registrars first, then the 5 cross-category
registrars (delivery tombstones, boundary unavailable, rpc-semantics
spurious-callback tombstone, rpc-semantics idempotence).

### [`ConsumedFrameView`](./_helpers.ts#L71)

_TypeAlias_

```ts
export type ConsumedFrameView = {
  readonly messageId: string;
  readonly leaseId: string;
};
```

### [`DISPATCH_ADMISSION_CATEGORY`](./_helpers.ts#L19)

_Variable_

```ts
export const DISPATCH_ADMISSION_CATEGORY = "dispatch-admission" as const
```

### [`dispatchAdmissionViolation`](./_helpers.ts#L53)

_Function_

```ts
export function dispatchAdmissionViolation(
  name: string,
  reason: string,
): PropertyInvariantViolation
```

### [`DispatchTestDriver`](./_driver.ts#L269)

_Interface_

```ts
export interface DispatchTestDriver {
  readonly recipient: RecipientHandle;
  readonly moderator: ModeratorHandle;
  readonly fixtures: {
    readonly taskId: Static<typeof TaskId>;
    readonly conversationId: Static<typeof ConversationId>;
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
```

Cross-impl driver. One `DispatchTestDriver` instance per property,
acquired under the property's `Scope`. Wires up the real server,
recipient + moderator clients, and shared task / conversation
fixtures.

### [`DispatchTestDriverConfig`](./_driver.ts#L333)

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

### [`DispatchVerdict`](./_driver.ts#L94)

_TypeAlias_

```ts
export type DispatchVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
```

Closed verdict union mirroring the wire `DispatchAdmissionDecisionSchema`.
Properties that need to script a moderator's reply pass a
`DispatchVerdict` value to `recipient.expectAuthorize` /
`respondWith`; the driver encodes it to the wire shape internally.

### [`FAST_ACK_THRESHOLD_MS`](./_helpers.ts#L44)

_Variable_

```ts
export const FAST_ACK_THRESHOLD_MS = 1_000
```

### [`FORBIDDEN_ERROR_CODE`](./_helpers.ts#L26)

_Variable_

```ts
export const FORBIDDEN_ERROR_CODE = -32001
```

### [`freshMessageId`](./_helpers.ts#L76)

_Function_

```ts
export function freshMessageId(): Static<typeof MessageId>
```

### [`HOLD_DRAIN_BUFFER_MS`](./_helpers.ts#L51)

_Variable_

```ts
export const HOLD_DRAIN_BUFFER_MS = 2_000
```

### [`HOLD_RELEASE_MARGIN_MS`](./_helpers.ts#L48)

_Variable_

```ts
export const HOLD_RELEASE_MARGIN_MS = 500
```

### [`isUuidV4`](./_helpers.ts#L85)

_Function_

```ts
export function isUuidV4(s: string): boolean
```

### [`leaseId`](./_helpers.ts#L73)

_Property_

```ts
  readonly leaseId: string;
```

### [`leaseId`](./_helpers.ts#L70)

_Property_

```ts
export type LeaseIdOnlyView = { readonly leaseId: string };
```

### [`leaseId`](./_helpers.ts#L67)

_Property_

```ts
  readonly leaseId: string;
```

### [`LeaseIdOnlyView`](./_helpers.ts#L70)

_TypeAlias_

```ts
export type LeaseIdOnlyView = { readonly leaseId: string };
```

### [`LeaseState`](./_driver.ts#L105)

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
`assertLeaseState` polls `dispatches/get` until the registry settles
to the named state or the bound elapses (impl-staff picks the bound
per-property; default 5 s).

### [`makeDispatchTestDriver`](./_driver.ts#L941)

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

### [`messageId`](./_helpers.ts#L72)

_Property_

```ts
  readonly messageId: string;
```

### [`ModeratorHandle`](./_driver.ts#L198)

_Interface_

```ts
export interface ModeratorHandle {
  readonly agentId: Static<typeof AgentId>;
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
      readonly taskId: Static<typeof TaskId>;
      readonly conversationId: Static<typeof ConversationId>;
      readonly messageId: Static<typeof MessageId>;
    }) => boolean;
    readonly holdResponseFor?: number;
  }) => Effect.Effect<void, PropertyFailure>;
```

Moderator-side surface. Owns one TestClient connected to the real
server under a moderator agent identity, with `apps/register` already
driven to install a `dispatch_authorize` hook for the test app. Holds
the registered `appId` for `dispatches/get` scope assertions.

### [`NEGATIVE_OBSERVABILITY_WINDOW_MS`](./_helpers.ts#L25)

_Variable_

```ts
export const NEGATIVE_OBSERVABILITY_WINDOW_MS = 750
```

### [`NO_SECOND_RELEASE_WINDOW_MS`](./_helpers.ts#L40)

_Variable_

```ts
export const NO_SECOND_RELEASE_WINDOW_MS = 250
```

### [`RecipientHandle`](./_driver.ts#L123)

_Interface_

```ts
export interface RecipientHandle {
  readonly agentId: Static<typeof AgentId>;

  /**
   * Issue `dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Static<typeof ConversationId>;
    readonly messageId: Static<typeof MessageId>;
    readonly senderAgentId: Static<typeof AgentId>;
    readonly attempt?: number;
  }) => Effect.Effect<
    {
      readonly leaseId: Static<typeof LeaseId>;
      readonly dispatchId: Static<typeof DispatchId>;
    },
    PropertyFailure
  >;
```

Recipient-side surface. Owns one TestClient connected to the real
server under a recipient agent identity. All methods return Effects
scoped to the surrounding `Scope`; releasing the scope closes the
underlying TestClient.

### [`registerAppDisconnectFailPolicy`](./app-disconnect-fail-policy.ts#L56)

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

### [`registerDispatchesGetModeratorSeesRecord`](./dispatches-get-moderator-sees.ts#L15)

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

### [`registerHookGatedDelivery`](./hook-gated-delivery.ts#L21)

_Function_

```ts
export function registerHookGatedDelivery(ctx: ConformanceRunContext): void
```

### [`registerIdempotence`](./idempotence.ts#L56)

_Function_

```ts
export function registerIdempotence(ctx: ConformanceRunContext): void
```

### [`registerMultiAppFifoShortCircuit`](./multi-app-fifo-short-circuit.ts#L18)

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

### [`registerSameConversationDispatchesConcurrent`](./same-conv-dispatches-concurrent.ts#L15)

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

### [`ReleaseFrameView`](./_helpers.ts#L66)

_TypeAlias_

```ts
export type ReleaseFrameView = {
  readonly leaseId: string;
  readonly verdict: { decision: string; reason?: string };
};
```

### [`SHORT_LEASE_TIMEOUT_MS`](./_helpers.ts#L21)

_Variable_

```ts
export const SHORT_LEASE_TIMEOUT_MS = 250
```

### [`TIMEOUT_RELEASE_WAIT_MS`](./_helpers.ts#L36)

_Variable_

```ts
export const TIMEOUT_RELEASE_WAIT_MS = 3_000
```

### [`TINY_MODERATOR_TIMEOUT_MS`](./_helpers.ts#L22)

_Variable_

```ts
export const TINY_MODERATOR_TIMEOUT_MS = 200
```

### [`TTL_OBSERVATION_BUFFER_MS`](./_helpers.ts#L23)

_Variable_

```ts
export const TTL_OBSERVATION_BUFFER_MS = 1_500
```

### [`verdict`](./_helpers.ts#L68)

_Property_

```ts
  readonly verdict: { decision: string; reason?: string };
```

### [`withDriver`](./_helpers.ts#L93)

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
