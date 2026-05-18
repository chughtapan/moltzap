/**
 * Stream-returning constructors for `MoltZapWsClient.subscribe` and
 * `MoltZapWsClient.subscribeAll` (Spec B, #596).
 *
 * Architect decision **AD1 — path (a)**: trust `Stream.runForEach`
 * cancellation to drive `Effect.acquireRelease`-mediated unregister. The
 * registry's `dispatch` snapshots `subsRef` at iteration start, so the
 * spec #222 §5.3 OQ-3 snapshot semantic is preserved by Ref atomicity
 * without an additional per-sub cancelled-flag check.
 *
 * Stream lifecycle (architect-mandated, spec §"Stream lifecycle contract"):
 *   1. `subscribe(def)` returns a Stream **value**. Pure; no I/O, no scope.
 *   2. Materialization (`Stream.runForEach` etc.) opens a Scope and runs
 *      `Effect.acquireRelease(registry.register, handle => handle.unregister)`.
 *   3. Pre-`connect()` consumer pulls **suspend** inside the per-sub queue's
 *      `Queue.take`. No `NotConnectedError` until terminal close.
 *   4. Reconnect leaves the per-sub queue intact; the registry's `subsRef`
 *      survives transient disconnects (preserved invariant).
 *   5. `MoltZapWsClient.close` invokes `SubscriberRegistry.closeAll` which
 *      shuts down every per-sub queue → outstanding Streams terminate with
 *      `NotConnectedError` in their error channel.
 *
 * **Architect stub** (Spec B). Impl-staff fills bodies, wires
 * `SubscriberRegistry.register`'s return shape, and adds the
 * `NotConnectedError` sentinel mapping inside `Stream.fromQueue` per the
 * §6 dataflow contract.
 */
import type { Stream } from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
  NotificationParamsOf,
} from "@moltzap/protocol";
import type { NotConnectedError } from "@moltzap/protocol";

import type { SubscriberRegistry } from "../runtime/subscribers.js";

class NotImplementedError extends Error {
  constructor(message = "architect stub — Spec B impl-staff scope") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Typed-payload subscribe. Returns a Stream of `DecodedNotification[D]`
 * whose error channel is `NotConnectedError` and whose requirement set is
 * `never` (the registry handle is bound at materialization time via
 * `Effect.acquireRelease` inside `Stream.unwrapScoped`, so the Scope
 * requirement is consumed internally and never leaks to the consumer).
 *
 * `refinement` is a typed predicate over the definition's params. When the
 * type-guard overload form is used (see signature below), the Stream's
 * payload is narrowed to `DecodedNotification[D, R]` (the narrowed
 * params-only variant requires the optional `R` parameter added to
 * `DecodedNotification[D]` in `packages/protocol/src/transport/rpc-groups.ts`).
 */
export function subscribe<D extends AnyNotificationDefinition>(
  registry: SubscriberRegistry,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, NotConnectedError, never>;
export function subscribe<
  D extends AnyNotificationDefinition,
  R extends NotificationParamsOf<D>,
>(
  registry: SubscriberRegistry,
  definition: D,
  refinement: (params: NotificationParamsOf<D>) => params is R,
): Stream.Stream<DecodedNotification<D>, NotConnectedError, never>;
export function subscribe(
  _registry: SubscriberRegistry,
  _definition: AnyNotificationDefinition,
  _refinement?: (params: unknown) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  NotConnectedError,
  never
> {
  throw new NotImplementedError();
}

/**
 * Broad-union escape hatch. The only intended in-tree consumer is
 * `MoltZapService.connect`, which uses this to fan every inbound
 * notification through `MoltZapService.handleNotification`. Payload
 * narrowing is intentionally lost; callers wanting typed payloads use
 * `subscribe(def, refinement?)`.
 *
 * Consumption pattern (spec Goal #8):
 *
 * ```ts
 * yield* client.subscribeAll().pipe(
 *   Stream.runForEach((n) => this.handleNotification(n)),
 *   Effect.forkScoped,
 * );
 * ```
 *
 * The forked fiber **must** be scoped into the service's connect-scope
 * (the `Effect.Scope` that owns `MoltZapService.connect`). Forking into
 * a wider scope leaks the fiber across `close()`/`connect()` cycles.
 */
export function subscribeAll(
  _registry: SubscriberRegistry,
  _refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  NotConnectedError,
  never
> {
  throw new NotImplementedError();
}

// The `Stream.runHead` + `Effect.timeoutFail` migration recipe lives in
// spec #596 §Acceptance criteria and the package's
// `docs/architecture/04-notification-subscription.md`. Impl-staff
// inlines at each call site or extracts a shared helper at their
// discretion within the spec's minimal-changes guidance.
