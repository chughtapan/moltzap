/**
 * Stream-returning constructors for `MoltZapAgentClient.subscribe` and
 * `MoltZapAgentClient.subscribeAll`.
 *
 * `Stream.async` cancellation drives the registry-stored `unregister`
 * finalizer. The registry's `dispatch` snapshots `subsRef` at iteration
 * start, so the snapshot semantic holds by Ref atomicity without a
 * per-sub cancelled-flag check.
 *
 * Stream construction uses `Stream.async&lt;NotificationParamsOf&lt;D>,
 * NotConnectedError>` with the registry storing typed callback references — NOT
 * `Queue` of `Take` items combined with `Stream.fromQueue`/`Stream.flattenTake`,
 * which is racy under `Queue.offer(Take.fail); Queue.shutdown` and does not
 * reliably propagate the typed failure to the consumer.
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
import { Stream } from "effect";
import {
  type NotConnectedError,
  type NotificationDelivery,
  type NotificationParamsOf,
  notificationSubscribe,
  notificationSubscribeAll,
  type NotificationSubscriberRegistry,
} from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";

type ClientNotificationDelivery =
  NotificationDelivery<AnyNotificationDefinition>;

/**
 * Typed-payload subscribe. Returns a Stream of `NotificationParamsOf&lt;D>`
 * whose error channel is `NotConnectedError` and whose requirement set is
 * `never` (the registry handle is bound at materialization time inside
 * `Stream.async`'s register callback, so neither Scope nor any other
 * requirement leaks to the consumer).
 *
 * `refinement` is a typed predicate over the definition's params. When the
 * type-guard overload form is used, the Stream's payload narrows to `R`.
 */
export function subscribe<
  D extends AnyNotificationDefinition,
  R extends NotificationParamsOf<D>,
>(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  definition: D,
  refinement: (params: NotificationParamsOf<D>) => params is R,
): Stream.Stream<R, NotConnectedError, never>;
export function subscribe<D extends AnyNotificationDefinition>(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, NotConnectedError, never>;
export function subscribe<D extends AnyNotificationDefinition>(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, NotConnectedError, never> {
  if (refinement === undefined)
    return notificationSubscribe(registry, definition);
  return notificationSubscribe(registry, definition, refinement);
}

/**
 * Broad-union escape hatch. The only intended in-tree consumer is
 * `MoltZapService.connect`, which uses this to fan every inbound
 * notification through `MoltZapService.handleNotification`. Payload
 * narrowing is intentionally lost; callers wanting typed payloads use
 * `subscribe(def, refinement?)`.
 *
 * The registry has no "match all" subscription shape (`subscribe&lt;D>` is
 * per-definition). `subscribeAll` instead registers via
 * `SubscriberRegistry.registerAll`, whose callbacks the dispatcher hits
 * for every inbound frame regardless of definition. Same lifecycle as
 * `register(def, …)`, no definition match.
 */
export function subscribeAll(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  refinement?: (
    definition: AnyNotificationDefinition,
    params: NotificationParamsOf<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<ClientNotificationDelivery, NotConnectedError, never> {
  if (refinement === undefined) {
    return notificationSubscribeAll(registry);
  }
  return notificationSubscribeAll(registry, (delivery) =>
    refinement(delivery.definition, delivery.params),
  );
}
