/**
 * Stream-returning constructors for `MoltZapWsClient.subscribe` and
 * `MoltZapWsClient.subscribeAll` (Spec B, #596).
 *
 * Architect decision **AD1 — path (a)**: trust `Stream.runForEach`
 * cancellation to drive `Effect.acquireRelease`-mediated unregister.
 * The registry's `dispatch` snapshots `subsRef` at iteration start, so
 * the spec #222 §5.3 OQ-3 snapshot semantic is preserved by Ref
 * atomicity without an additional per-sub cancelled-flag check.
 *
 * **r5 architecture change** (per codex r4 finding #1): Stream is built
 * via `Stream.{async}` over `DecodedNotification[D]` + `NotConnectedError` with
 * the registry storing typed callback references — NOT the prior
 * `Queue` of `Take` items combined with `Stream.fromQueue` + `Stream.flattenTake` design,
 * which codex empirically verified is racy under
 * `Queue.offer(Take.fail); Queue.shutdown` and does not reliably
 * propagate the typed failure to the consumer.
 *
 * Stream lifecycle (architect-mandated, spec §"Stream lifecycle contract"):
 *   1. `subscribe(def)` returns a Stream **value**. Pure; no I/O, no scope.
 *   2. Materialization opens the Stream.{async} source: registry.register
 *      runs synchronously, callbacks are installed; consumer pulls
 *      suspend until `emit.single` fires from dispatch.
 *   3. Pre-`connect()` consumer pulls **suspend** inside Stream.{async}'s
 *      internal queue. No `NotConnectedError` until terminal close.
 *   4. Reconnect leaves registry callbacks intact; `subsRef` survives
 *      transient disconnects (preserved invariant).
 *   5. `MoltZapWsClient.close` invokes `SubscriberRegistry.closeAll`,
 *      which calls each live `sub.onClose(new NotConnectedError(...))`.
 *      Each `Stream.{async}`-backed consumer fails with NotConnectedError
 *      via `emit.fail` deterministically (no Queue/shutdown race).
 *
 * **Architect stub** (Spec B). Impl-staff fills bodies per the
 * `Stream.{async}` design in architect plan §5.5.
 */
import { Stream } from "effect";
import type {
  AnyNotificationDefinition,
  DecodedNotification,
  NotificationParamsOf,
} from "@moltzap/protocol";
import type { NotConnectedError } from "@moltzap/protocol";

import type { SubscriberRegistry } from "../runtime/subscribers.js";

// Per architect-revision r1 (codex r1 finding #5): no `NotImplementedError`
// class — that symbol does not exist in this repo. The `subscribe` and
// `subscribeAll` functions are pure factories returning Stream values,
// so the stub bodies return `Stream.dieMessage(...)` — a Stream that
// raises a defect on consumption. Impl-staff replaces with the real
// `Stream.{async}(...)` construction per architect plan §5.5.

/**
 * Typed-payload subscribe. Returns a Stream of `DecodedNotification[D]`
 * whose error channel is `NotConnectedError` and whose requirement set is
 * `never` (the registry handle is bound at materialization time inside
 * `Stream.{async}`'s register callback, so neither Scope nor any other
 * requirement leaks to the consumer).
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
  return Stream.dieMessage("architect stub — Spec B impl-staff scope");
}

/**
 * Broad-union escape hatch. The only intended in-tree consumer is
 * `MoltZapService.connect`, which uses this to fan every inbound
 * notification through `MoltZapService.handleNotification`. Payload
 * narrowing is intentionally lost; callers wanting typed payloads use
 * `subscribe(def, refinement?)`.
 *
 * Consumption pattern (spec Goal #8, architect plan §4.2 service.ts row):
 *
 * ```ts
 * // Inside MoltZapService.connect — fork into a SERVICE-OWNED
 * // Scope.CloseableScope (this.serviceScope), opened in connect() and
 * // closed in close(). Do NOT use Effect.forkScoped here unless
 * // connect() itself is scoped (which would leak Scope to callers).
 * this.serviceFiber = Effect.runFork(
 *   client.subscribeAll().pipe(
 *     Stream.runForEach((n) => this.handleNotification(n)),
 *     Effect.forkIn(this.serviceScope),
 *   ),
 * );
 * ```
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
  return Stream.dieMessage("architect stub — Spec B impl-staff scope");
}

// The `Stream.runHead` + `Effect.timeoutFail` migration recipe lives in
// spec #596 §Acceptance criteria and the package's
// `docs/architecture/04-notification-subscription.md`. Impl-staff
// inlines at each call site or extracts a shared helper at their
// discretion within the spec's minimal-changes guidance.
