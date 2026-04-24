/**
 * Per-subscription event registry for `MoltZapWsClient`.
 *
 * Responsibility: own the list of live `subscribe()` handles and fan each
 * inbound `EventFrame` out to every subscription whose filter matches.
 * Implements spec #222 §5.3 (C4 + the `RealClientEventSubscriber.subscribe`
 * filter stub). Lives as an internal collaborator of `MoltZapWsClient`;
 * the public types (`SubscriptionFilter`, `EventSubscription`,
 * `SubscriptionId`) re-export from the package barrel.
 *
 * Dispatch ordering (Invariant 6 — events delivered in arrival order):
 *   1. Inbound frames are handed to the registry in arrival order.
 *   2. Within a single frame, subscriptions are notified in registration
 *      order.
 *   3. There is no separate legacy `onEvent` fanout — spec #222 OQ-4 is
 *      resolved by DELETING `MoltZapWsClientOptions.onEvent`. Callers
 *      that want "every event" register `subscribe({}, handler)` after
 *      construction and before `connect()`.
 *
 * Unsubscribe semantics (OQ-3 A): `unsubscribe` takes effect on the next
 * frame. The registry snapshots its live-subscription list at the start
 * of each `dispatch` call; in-flight dispatch of frame N is not
 * interrupted by an unsubscribe during frame N. Frame N+1 observes the
 * unsubscribed state.
 *
 * Error channel: handlers are invoked inside a defect-catcher; a throw is
 * logged via the client's injected `WsClientLogger` and swallowed
 * (matching the prior `onEvent` contract at `ws-client.ts:650-655`
 * pre-deletion). The registry itself has no typed error surface —
 * `register`, `dispatch`, and `closeAll` are `Effect<T, never>`.
 */
import { Effect, Ref } from "effect";
import type { EventFrame } from "@moltzap/protocol";

/** Branded identifier for a subscription handle. Minted by `register`. */
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/**
 * Filter grammar for `subscribe`. An event is delivered to a subscription
 * iff it matches **every** field that is set on the filter. Unset fields
 * are wildcards; the empty filter `{}` matches every event.
 *
 * OQ-2 resolution (A): exactly these three fields, no free-form
 * predicate, no schema-derived matcher. Matches the existing
 * `RealClientEventFilter` contract at
 * `packages/protocol/src/testing/conformance/client/runner.ts:104-116`
 * one-for-one.
 *
 *   - `emissionTag` — exact match against the canonical payload key
 *     `frame.data.__emissionTag`. (The adapter reads the same key at
 *     `packages/client/src/test-utils/conformance-adapter.ts:77-79`;
 *     `emitTaggedEventDefault` writes it at `runner.ts:343-357`. The
 *     `__emissionId` string in the `runner.ts:108` doc comment is a
 *     known doc-bug — architect files a follow-up issue against
 *     protocol to correct the comment; it is not the canonical name.)
 *   - `conversationId` — exact match against `frame.data.conversationId`
 *     when set on the event payload.
 *   - `eventNamePrefix` — `frame.event.startsWith(prefix)`.
 */
export interface SubscriptionFilter {
  readonly emissionTag?: string;
  readonly conversationId?: string;
  readonly eventNamePrefix?: string;
}

/**
 * Handle returned by `register` / `MoltZapWsClient.subscribe`. Caller
 * holds the handle for its subscription's lifetime and runs
 * `unsubscribe` to stop delivery.
 *
 * `unsubscribe` is `Effect<void, never>`: it is idempotent and total.
 * Calling `unsubscribe` a second time, or after `closeAll`, is a no-op.
 */
export interface EventSubscription {
  readonly id: SubscriptionId;
  readonly unsubscribe: Effect.Effect<void, never>;
}

/**
 * Per-subscription handler signature. Runs inside the registry's
 * dispatch fiber. Must not throw — throws are caught by the registry,
 * logged via the injected logger, and swallowed.
 *
 * Returning an `Effect` (not a plain `void`) lets handlers compose with
 * Effect-native downstream code without an extra runSync shim. The
 * registry awaits each handler's effect before moving to the next
 * subscription for this frame — fairness over throughput, so a slow
 * handler on subscription A does not reorder frames seen by
 * subscription B across frames.
 */
export type SubscriberHandler = (
  frame: EventFrame,
) => Effect.Effect<void, never>;

/**
 * Subscriber registry. One instance per `MoltZapWsClient`, created at
 * construction time and owned by the client. Not exported from the
 * package barrel — consumers reach the registry only through
 * `MoltZapWsClient.subscribe`.
 */
export interface SubscriberRegistry {
  /**
   * Add a subscription. Returns the handle immediately; delivery starts
   * with the next frame passed to `dispatch`. Does not await any
   * connection state — subscribe is legal pre-connect (spec §5.3 +
   * Assumption 1 deletion: post-delete of `onEvent`, subscribe is the
   * only pre-connect event hook).
   */
  readonly register: (
    filter: SubscriptionFilter,
    handler: SubscriberHandler,
  ) => Effect.Effect<EventSubscription, never>;

  /**
   * Fan an inbound event out to every matching subscription. Called by
   * `MoltZapWsClient.handleIncoming` at the existing event-dispatch
   * point (`ws-client.ts:649-685`). Implementation snapshots the
   * live-subscription list at the start of dispatch so
   * unsubscribe-during-dispatch observes next-frame semantics (OQ-3 A).
   *
   * Dispatch order: registration order, iterated sequentially; slow
   * handlers block later subscriptions for this frame but never
   * reorder frame N relative to frame N+1.
   */
  readonly dispatch: (frame: EventFrame) => Effect.Effect<void, never>;

  /**
   * Drop every live subscription. Called from `MoltZapWsClient.close`
   * so handlers stop firing once the client is torn down. Idempotent.
   */
  readonly closeAll: Effect.Effect<void, never>;
}

interface LiveSubscription {
  readonly id: SubscriptionId;
  readonly filter: SubscriptionFilter;
  readonly handler: SubscriberHandler;
}

/**
 * Construct an empty registry. Called once from the `MoltZapWsClient`
 * constructor. Takes a logger so registry-internal error logs reach the
 * same sink as the rest of the client.
 *
 * Implementation notes:
 *   - Live subscriptions are stored in a `Ref<ReadonlyArray<…>>` keyed
 *     by registration order. Append-on-register, filter-on-unsubscribe
 *     keeps the dispatch path O(N) with N = live subscription count.
 *     Bigger structures aren't justified at the expected sub count
 *     (≤ ~10 per fixture).
 *   - `dispatch` snapshots the array at start (OQ-3 A). An
 *     `unsubscribe` mid-dispatch mutates the Ref but the in-flight
 *     iteration walks the snapshot.
 *   - Handler exceptions are caught with `Effect.catchAllDefect` after
 *     the handler Effect. Sync `throw` from a `(frame) => …` body
 *     surfaces as a defect; we log + swallow to match the pre-deletion
 *     `onEvent` contract.
 */
export function makeSubscriberRegistry(logger: {
  readonly warn: (...args: ReadonlyArray<unknown>) => void;
}): Effect.Effect<SubscriberRegistry, never> {
  return Effect.gen(function* () {
    const subsRef = yield* Ref.make<ReadonlyArray<LiveSubscription>>([]);
    const counterRef = yield* Ref.make(0);

    const register: SubscriberRegistry["register"] = (filter, handler) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(counterRef, (c) => c + 1);
        const id = `sub-${n}` as SubscriptionId;
        const live: LiveSubscription = { id, filter, handler };
        yield* Ref.update(subsRef, (xs) => [...xs, live]);
        const unsubscribe: Effect.Effect<void, never> = Ref.update(
          subsRef,
          (xs) => xs.filter((s) => s.id !== id),
        );
        return { id, unsubscribe };
      });

    const dispatch: SubscriberRegistry["dispatch"] = (frame) =>
      Effect.gen(function* () {
        // Snapshot at dispatch-start: OQ-3 A. Unsubscribes during this
        // frame mutate `subsRef` but our iteration walks `snapshot`.
        const snapshot = yield* Ref.get(subsRef);
        // Short-circuit the common pre-subscribe path (every inbound
        // frame before any `subscribe()` call) so hot-path dispatch
        // avoids even the `for…of` allocation.
        if (snapshot.length === 0) return;
        for (const sub of snapshot) {
          if (!matchesFilter(sub.filter, frame)) continue;
          // Handlers must not throw; we catch defects defensively so
          // one buggy subscriber can't kill the dispatch loop or break
          // the reader fiber.
          yield* sub.handler(frame).pipe(
            Effect.catchAllDefect((err) =>
              Effect.sync(() => {
                logger.warn("subscriber handler threw", err);
              }),
            ),
          );
        }
      });

    const closeAll: Effect.Effect<void, never> = Ref.set(subsRef, []);

    return { register, dispatch, closeAll };
  });
}

/**
 * Pure filter-match predicate. Exposed for unit testing so the C4
 * divergence proof in
 * `packages/protocol/src/testing/conformance/__divergence_proofs__/client-delivery.proofs.ts`
 * can mutate this predicate (e.g., force it to always return `true`) to
 * flip the vacuity assertions.
 *
 * Returns `true` iff `frame` matches every set field on `filter`:
 *   - `filter.emissionTag === frame.data.__emissionTag` (strict ===)
 *   - `filter.conversationId === frame.data.conversationId` (strict ===)
 *   - `frame.event.startsWith(filter.eventNamePrefix)`
 * Unset filter fields are wildcards.
 */
export function matchesFilter(
  filter: SubscriptionFilter,
  frame: EventFrame,
): boolean {
  if (filter.eventNamePrefix !== undefined) {
    if (!frame.event.startsWith(filter.eventNamePrefix)) return false;
  }
  // `frame.data` is `unknown` per the EventFrame schema; narrow it to
  // a record before reading the two payload-keyed fields. Anything
  // else (string, number, array) cannot satisfy a payload-key filter.
  // The cast is annotated below: the EventFrame schema declares `data:
  // unknown`, and the OQ-2 A filter grammar intentionally treats
  // payloads as untyped maps so arbitrary publisher payloads can be
  // filtered without a per-event schema tax. The `typeof === "object"`
  // guard is the runtime boundary; the read sites
  // (`data?.["__emissionTag"]`, `data?.["conversationId"]`) defend
  // against missing or wrong-typed values via `=== filter.<field>`.
  const data: Record<string, unknown> | null =
    typeof frame.data === "object" &&
    frame.data !== null &&
    !Array.isArray(frame.data)
      ? (frame.data as Record<string, unknown>) // #ignore-sloppy-code[record-cast]: EventFrame schema declares `data: unknown`; OQ-2 A filter treats payloads as untyped maps; the typeof guard above is the runtime boundary
      : null;

  if (filter.emissionTag !== undefined) {
    const tag = data?.["__emissionTag"];
    if (tag !== filter.emissionTag) return false;
  }
  if (filter.conversationId !== undefined) {
    const cid = data?.["conversationId"];
    if (cid !== filter.conversationId) return false;
  }
  return true;
}
