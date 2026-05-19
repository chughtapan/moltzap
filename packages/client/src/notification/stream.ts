/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `Stream.async<DecodedNotification<D>>` use the natural angle-bracket form (TS source style) inside backtick-fenced code spans; the lint rule's pre-render check fires false positives on these multi-line spans. Matches the precedent in filter-equivalence.test.ts. */

/**
 * Stream-returning constructors for `MoltZapWsClient.subscribe` and
 * `MoltZapWsClient.subscribeAll` (Spec B, #596).
 *
 * Architect decision **AD1 — path (a)**: trust `Stream.async` cancellation
 * to drive registry-stored `unregister` finalizer. The registry's
 * `dispatch` snapshots `subsRef` at iteration start, so the spec #222
 * §5.3 OQ-3 snapshot semantic is preserved by Ref atomicity without an
 * additional per-sub cancelled-flag check (architect plan §3).
 *
 * Stream construction uses `Stream.async<DecodedNotification<D>, NotConnectedError>`
 * with the registry storing typed callback references — NOT `Queue` of
 * `Take` items combined with `Stream.fromQueue`/`Stream.flattenTake`,
 * which codex empirically verified is racy under
 * `Queue.offer(Take.fail); Queue.shutdown` and does not reliably propagate
 * the typed failure to the consumer (architect plan §3.2, codex r4).
 *
 * Stream lifecycle (architect-mandated, spec §"Stream lifecycle contract"):
 *   1. `subscribe(def)` returns a Stream value. Pure; no I/O, no scope.
 *   2. Materialization opens the `Stream.async` source: `registry.register`
 *      runs synchronously, callbacks are installed; consumer pulls suspend
 *      until `emit.single` fires from dispatch.
 *   3. Pre-`connect()` consumer pulls suspend inside `Stream.async`'s
 *      internal queue. No `NotConnectedError` until terminal close.
 *   4. Reconnect leaves registry callbacks intact; `subsRef` survives
 *      transient disconnects (preserved invariant).
 *   5. `MoltZapWsClient.close` invokes `SubscriberRegistry.closeAll`, which
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
    // Per P3 issue #613: use `Effect.suspend` to defer running `unregister`
    // to whenever the Stream's runtime invokes the finalizer Effect. This
    // is future-proof if `unregister` ever grows yielded effects (e.g.
    // flushing a queue); the `Effect.sync(() => Effect.runSync(handle.unregister))`
    // form would force-eager-evaluate as sync.
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
 * The `subscribeAll` Stream uses a synthetic "match every definition"
 * filter — implemented by the registry treating a `null` definition
 * pointer as "match all", but for the Stream API we instead register
 * one subscription per inbound frame's definition. Simpler: model
 * "match all" by passing an in-band sentinel.
 *
 * Implementation: the registry has no native "match all" subscription
 * shape (intentional — `subscribe<D>` is per-definition). To preserve
 * the registry's typed dispatch surface, `subscribeAll` constructs a
 * Stream that taps the registry via a per-arrival path: registering
 * once with a sentinel definition would require a registry-level "match
 * any" capability we deliberately avoid (would complicate the typed
 * dispatch in subscribers.ts). Instead, the dispatcher feeds every
 * frame to `subscribeAll`'s emit via a dedicated `subscribeAllRef`
 * callback list maintained alongside `subsRef`.
 *
 * Architect-mandated code shape: per spec Goal #2 / plan §5.3, the
 * surface returns a Stream value. Implementation passes the literal
 * `AnyNotificationDefinition` sentinel via the registry's broad-union
 * channel — see `notification/stream.ts → subscribeAllStream` below
 * which registers via a new `SubscriberRegistry.registerAll` helper.
 *
 * To keep the registry minimal we route `subscribeAll` through a thin
 * wrapper that the registry exposes as `registerAll(callbacks)` —
 * identical lifecycle to `register(def, …)` but with no definition
 * match (the dispatcher hits these callbacks for every inbound frame).
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
