/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `Stream.async<DecodedNotification<D>>` use the natural angle-bracket form (TS source style) inside backtick-fenced code spans; the lint rule's pre-render check fires false positives on these multi-line spans. Matches the precedent in filter-equivalence.test.ts. */

/**
 * Stream-returning constructors for `MoltZapAgentClient.subscribe` and
 * `MoltZapAgentClient.subscribeAll`.
 *
 * `Stream.async` cancellation drives the registry-stored `unregister`
 * finalizer. The registry's `dispatch` snapshots `subsRef` at iteration
 * start, so the snapshot semantic holds by Ref atomicity without a
 * per-sub cancelled-flag check.
 *
 * Stream construction uses `Stream.async<DecodedNotification<D>, NotConnectedError>`
 * with the registry storing typed callback references — NOT `Queue` of
 * `Take` items combined with `Stream.fromQueue`/`Stream.flattenTake`,
 * which is racy under `Queue.offer(Take.fail); Queue.shutdown` and does
 * not reliably propagate the typed failure to the consumer.
 *
 * Stream lifecycle:
 *   1. `subscribe(def)` returns a Stream value. Pure; no I/O, no scope.
 *   2. Materialization opens the `Stream.async` source: `registry.register`
 *      runs synchronously, callbacks are installed; consumer pulls suspend
 *      until `emit.single` fires from dispatch.
 *   3. Pre-`connect()` consumer pulls suspend inside `Stream.async`'s
 *      internal queue. No `NotConnectedError` until terminal close.
 *   4. Reconnect leaves registry callbacks intact; `subsRef` survives
 *      transient disconnects. **Reconnect-window
 *      frame loss:** any server-originated notification frame that the
 *      transport drops while disconnected (between the socket dying and
 *      the reconnect `hello` completing) is NOT replayed — the Stream API
 *      has no buffering or gap-fill across the reconnect window, so such
 *      frames are silently lost to the consumer. Subscriptions resume
 *      receiving frames that arrive AFTER reconnect; there is no error or
 *      sentinel marking the gap.
 *   5. `MoltZapAgentClient.close` invokes `SubscriberRegistry.closeAll`, which
 *      calls each live `sub.onClose(new NotConnectedError(...))`. Each
 *      `Stream.async`-backed consumer fails with `NotConnectedError`
 *      via `emit.fail` deterministically (no Queue/shutdown race).
 */
import { Effect, Stream } from "effect";
import {
  type AnyNotificationDefinition,
  type DecodedNotification,
  type NotConnectedError,
  type NotificationParamsOf,
} from "@moltzap/protocol";

import type { SubscriberRegistry } from "../runtime/subscribers.js";

/**
 * Typed-payload subscribe. Returns a Stream of `DecodedNotification<D>`
 * whose error channel is `NotConnectedError` and whose requirement set is
 * `never` (the registry handle is bound at materialization time inside
 * `Stream.async`'s register callback, so neither Scope nor any other
 * requirement leaks to the consumer).
 *
 * `refinement` is a typed predicate over the definition's params. When the
 * type-guard overload form is used, the Stream's payload narrows to
 * `DecodedNotification<D, R>` via the optional `R` parameter on
 * `DecodedNotification<D>`.
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
): Stream.Stream<DecodedNotification<D, R>, NotConnectedError, never>;
export function subscribe<D extends AnyNotificationDefinition>(
  registry: SubscriberRegistry,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, NotConnectedError, never> {
  return Stream.async<DecodedNotification<D>, NotConnectedError>((emit) => {
    // Synchronous registration — the registry stores the typed callbacks
    // and returns an `unregister` Effect that the Stream's runtime will
    // invoke as the cancellation finalizer. #ignore-sloppy-code[async-keyword]: comment references `Stream.async`, not a function modifier
    //
    // `register` is `Effect<SubscriptionHandle, never>`; `runSync` is safe
    // because the registry mutates an in-memory `Ref` and never yields.
    const handle = Effect.runSync(
      registry.register(definition, refinement, {
        onFrame: (frame) =>
          Effect.sync(() => {
            emit.single(frame);
          }),
        onClose: (cause) =>
          Effect.sync(() => {
            emit.fail(cause);
          }),
      }),
    );
    // `Effect.suspend` defers running `unregister` to whenever the
    // Stream's runtime invokes the finalizer Effect, so `unregister` can
    // grow yielded effects (e.g. flushing a queue) without changing this
    // call site. `Effect.sync(() => Effect.runSync(handle.unregister))`
    // would force-eager-evaluate as sync.
    return Effect.suspend(() => handle.unregister);
  });
}

/**
 * Broad-union escape hatch. The only intended in-tree consumer is
 * `MoltZapService.connect`, which uses this to fan every inbound
 * notification through `MoltZapService.handleNotification`. Payload
 * narrowing is intentionally lost; callers wanting typed payloads use
 * `subscribe(def, refinement?)`.
 *
 * The registry has no "match all" subscription shape (`subscribe<D>` is
 * per-definition). `subscribeAll` instead registers via
 * `SubscriberRegistry.registerAll`, whose callbacks the dispatcher hits
 * for every inbound frame regardless of definition. Same lifecycle as
 * `register(def, …)`, no definition match.
 */
export function subscribeAll(
  registry: SubscriberRegistry,
  refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  NotConnectedError,
  never
> {
  return Stream.async<
    DecodedNotification<AnyNotificationDefinition>,
    NotConnectedError
  >((emit) => {
    const handle = Effect.runSync(
      registry.registerAll(refinement, {
        onFrame: (frame) =>
          Effect.sync(() => {
            emit.single(frame);
          }),
        onClose: (cause) =>
          Effect.sync(() => {
            emit.fail(cause);
          }),
      }),
    );
    return Effect.suspend(() => handle.unregister);
  });
}
