/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `NotificationParamsOf<D>` use the natural angle-bracket form (TS source style) inside backtick-fenced code spans; the lint rule's pre-render check fires false positives on these multi-line spans. Matches the precedent in filter-equivalence.test.ts. */

/**
 * Per-subscription notification registry for `MoltZapAgentClient`.
 *
 * Responsibility: own the list of live subscriptions and fan each inbound
 * JSON-RPC notification out to every subscription whose definition (and
 * optional typed refinement predicate) matches. Implements spec #596
 * (notification consumption consolidation) via the AD1 path-(a) Stream.async
 * design (architect plan §3, §5.5).
 *
 * Storage shape (post-Spec B):
 *   - Subscriptions are records of typed `{onFrame, onClose}` callbacks
 *     (NOT queues / Take items / Stream.fromQueue). `notification/stream.ts`
 *     owns Stream construction via `Stream.async`; this module owns the
 *     register/dispatch/closeAll lifecycle.
 *   - The dispatch path snapshots `subsRef` at iteration start (AD1
 *     snapshot-semantic contract from spec #222 §5.3 OQ-3 / spec #596
 *     "Stream lifecycle contract" row).
 *   - `closeAll` invokes each live sub's `onClose(new NotConnectedError(...))`
 *     before clearing `subsRef` — deterministic typed-failure delivery
 *     replaces the deleted `failAllNotificationWaiters` semantic.
 *
 * Filter grammar (post-Spec B):
 *   - Subscription matches a frame iff `sub.definition === frame.definition`.
 *   - Optional `refinement` is a typed predicate over the frame's params
 *     (erased to the union type `ErasedNotificationRefinement` at the
 *     storage boundary; consumers receive the typed-narrowed shape via
 *     `Stream.async`'s typed `emit.single` callback inside
 *     `notification/stream.ts`).
 *   - The three-field `SubscriptionFilter` grammar is deleted (spec #596
 *     Goal #3 + §"Acceptance criteria" delete sweep). Multi-definition
 *     fan-out becomes `Stream.mergeAll([subscribe(d1), subscribe(d2)])`.
 */
import { Brand, Effect, Ref } from "effect";
import {
  NotConnectedError,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type NotificationParamsOf,
} from "@moltzap/protocol";

/** Branded identifier for a subscription handle. Minted by `register`. */
type SubscriptionId = string & Brand.Brand<"SubscriptionId">;
const SubscriptionIdBrand = Brand.nominal<SubscriptionId>();

/**
 * Erased refinement predicate type stored on `LiveSubscription`. Bounds at
 * the broad-union params shape, never `unknown` / `any`. The typed
 * `(params: NotificationParamsOf<D>) => boolean` form is coerced through
 * this union inside `register` via a single named adapter — the only
 * place the typed → erased boundary crosses.
 */
type ErasedNotificationRefinement = (
  params: NotificationParamsOf<AnyNotificationDefinition>,
) => boolean;

/**
 * Per-subscription callback delivered each matching frame. Implemented in
 * `notification/stream.ts` as `(frame) => Effect.sync(() => emit.single(frame))`.
 * Returning `Effect<void, never>` keeps the dispatch path total — the
 * Stream-side `emit.single` cannot fail synchronously.
 */
type SubscriberFrameCallback = (
  frame: DecodedNotification<AnyNotificationDefinition>,
) => Effect.Effect<void, never>;

/**
 * Per-subscription callback invoked exactly once when the client transitions
 * to its terminal closed state. Implemented in `notification/stream.ts` as
 * `(cause) => Effect.sync(() => emit.fail(cause))`.
 */
type SubscriberCloseCallback = (
  cause: NotConnectedError,
) => Effect.Effect<void, never>;

/**
 * Live subscription record stored in `subsRef`. Heterogeneous storage: the
 * `definition` keeps the per-`D` shape but the callbacks are erased to the
 * union types declared above so the registry can iterate without re-narrowing.
 */
interface LiveSubscription {
  readonly id: SubscriptionId;
  readonly definition: AnyNotificationDefinition;
  readonly refinement?: ErasedNotificationRefinement;
  readonly onFrame: SubscriberFrameCallback;
  readonly onClose: SubscriberCloseCallback;
}

/**
 * Handle returned by `register`. `unregister` is `Effect<void, never>`: it
 * is idempotent and total. Calling `unregister` a second time, or after
 * `closeAll`, is a no-op.
 */
interface SubscriptionHandle {
  readonly id: SubscriptionId;
  readonly unregister: Effect.Effect<void, never>;
}

/**
 * Subscriber registry. One instance per `MoltZapAgentClient`, created at
 * construction time and owned by the client.
 *
 * `register<D>` accepts typed `onFrame` / `onClose` callbacks for the
 * specific definition `D`; internally the registry erases them to the
 * `Subscriber{Frame,Close}Callback` union shape so a single iteration
 * can dispatch over heterogeneous subscriptions without per-`D`
 * dispatch tables.
 *
 * Subscription lifecycle, paired with `Stream.async` consumers in
 * `notification/stream.ts`:
 *
 * ```mermaid
 * sequenceDiagram
 *   participant caller
 *   participant ws as MoltZapWsClient
 *   participant stream as notification/stream.ts
 *   participant registry as SubscriberRegistry
 *   participant reader as WS reader fiber
 *   participant server
 *
 *   caller->>ws: client.subscribe(def, refinement?)
 *   Note over ws: pure — returns Stream value, no I/O
 *   ws-->>caller: Stream<DecodedNotification<D>, NotConnectedError>
 *   caller->>caller: Stream.runForEach / runHead
 *   Note over stream: materialization runs `Stream.async`'s register synchronously
 *   stream->>registry: register(def, refinement, {onFrame, onClose})
 *   Note over registry: Ref.update(subsRef, append live)<br>return {unregister}
 *   Note over stream: onFrame → emit.single<br>onClose → emit.fail<br>finalizer → handle.unregister
 *   server->>reader: notification frame
 *   reader->>ws: handleIncoming → handleDecodedNotification
 *   ws->>registry: dispatch(decoded)
 *   Note over registry: snapshot = Ref.get(subsRef)<br>for sub in snapshot — match def + refinement → onFrame
 *   registry-->>caller: emit.single — runForEach handler fires
 *   caller->>stream: scope ends
 *   stream->>registry: handle.unregister — Ref.update drop
 *   ws->>registry: closeAll on client.close
 *   Note over registry: every live sub → onClose(NotConnectedError)<br>Ref.set(subsRef, [])
 * ```
 *
 * AD1 snapshot semantic: `dispatch` snapshots `subsRef` at iteration
 * start and never re-reads mid-loop. In-flight dispatch of frame N is
 * not interrupted by an unsubscribe that lands during frame N. The
 * `snapshot-semantics` tests pin this invariant end-to-end.
 *
 * Reconnect: subscriptions survive the reconnect path. The new socket
 * resumes feeding `onFrame`; frames dropped at the transport during
 * the disconnect window are a wire-protocol limitation (no per-frame
 * ack at this layer). Terminal close fires `closeAll` →
 * `emit.fail(NotConnectedError)` to every in-flight Stream.
 *
 * Subscribe-before-trigger: when a caller needs to observe a
 * notification that follows a specific RPC, materialise the Stream
 * BEFORE issuing the trigger — `Effect.fork(subscribe(def).pipe(...))`
 * then `client.sendRpc(triggerDef, params)` then `Fiber.join`.
 * Subscribing after the trigger is racy.
 */
export interface SubscriberRegistry {
  readonly register: <D extends AnyNotificationDefinition>(
    definition: D,
    refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
    callbacks: {
      readonly onFrame: (
        frame: DecodedNotification<D>,
      ) => Effect.Effect<void, never>;
      readonly onClose: SubscriberCloseCallback;
    },
  ) => Effect.Effect<SubscriptionHandle, never>;

  /**
   * `subscribeAll` surface (spec #596 Goal #2). Registers a broad-union
   * subscription that fires for every inbound frame regardless of
   * definition. The optional `refinement` predicate runs against the
   * full `DecodedNotification<AnyNotificationDefinition>` shape.
   *
   * Stored in a sibling `subsAllRef` list — kept off `subsRef` so the
   * per-definition dispatch loop in `dispatch` stays a simple
   * `definition ===` check without a per-sub broad-union escape branch.
   */
  readonly registerAll: (
    refinement:
      | ((
          notification: DecodedNotification<AnyNotificationDefinition>,
        ) => boolean)
      | undefined,
    callbacks: {
      readonly onFrame: SubscriberFrameCallback;
      readonly onClose: SubscriberCloseCallback;
    },
  ) => Effect.Effect<SubscriptionHandle, never>;

  /**
   * Fan an inbound notification out to every matching subscription. Called
   * from `MoltZapAgentClient.handleDecodedNotification`. Snapshot semantic:
   * unsubscribes that commit mid-dispatch observe NEXT-frame semantics
   * (AD1 path-(a) contract).
   */
  readonly dispatch: (
    frame: DecodedNotification<AnyNotificationDefinition>,
  ) => Effect.Effect<void, never>;

  /**
   * Terminal close. Invokes every live sub's `onClose` callback (which
   * `emit.fail(cause)`s the corresponding consumer Stream), then clears
   * both `subsRef` and `subsAllRef`. Idempotent.
   */
  readonly closeAll: Effect.Effect<void, never>;
}

interface LiveBroadSubscription {
  readonly id: SubscriptionId;
  readonly refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean;
  readonly onFrame: SubscriberFrameCallback;
  readonly onClose: SubscriberCloseCallback;
}

function nextSubscriptionId(
  counterRef: Ref.Ref<number>,
): Effect.Effect<SubscriptionId> {
  return Ref.updateAndGet(counterRef, (count) => count + 1).pipe(
    Effect.map((count) => SubscriptionIdBrand(`sub-${count}`)),
  );
}

function appendSubscription(
  subsRef: Ref.Ref<ReadonlyArray<LiveSubscription>>,
  live: LiveSubscription,
): Effect.Effect<void> {
  return Ref.update(subsRef, (subscriptions) => [...subscriptions, live]);
}

function removeSubscription(
  subsRef: Ref.Ref<ReadonlyArray<LiveSubscription>>,
  id: SubscriptionId,
): Effect.Effect<void> {
  return Ref.update(subsRef, (subscriptions) =>
    subscriptions.filter((subscription) => subscription.id !== id),
  );
}

function dispatchToSubscriber(
  sub: LiveSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onFrame(frame)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("subscriber onFrame callback threw", err),
    ),
  );
}

function closeSubscriber(
  sub: LiveSubscription,
  cause: NotConnectedError,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onClose(cause)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("subscriber onClose callback threw", err),
    ),
  );
}

/**
 * Construct an empty registry. Called once from the `MoltZapAgentClient`
 * constructor.
 *
 * Implementation notes:
 *   - `subsRef: Ref<ReadonlyArray<LiveSubscription>>` keyed by registration
 *     order. Append-on-register, filter-on-unregister keeps the dispatch
 *     path O(N) with N = live subscription count.
 *   - `dispatch` snapshots `subsRef` at iteration start. An unregister
 *     mid-dispatch mutates the Ref but the in-flight iteration walks the
 *     snapshot (AD1 path-(a) snapshot semantic).
 *   - `closeAll` invokes each live sub's `onClose` in iteration order
 *     before clearing the ref. `Stream.async`'s `emit.fail` is the
 *     deterministic in-Effect mechanism that propagates the typed
 *     failure to each consumer.
 */
function appendBroadSubscription(
  subsAllRef: Ref.Ref<ReadonlyArray<LiveBroadSubscription>>,
  live: LiveBroadSubscription,
): Effect.Effect<void> {
  return Ref.update(subsAllRef, (subscriptions) => [...subscriptions, live]);
}

function removeBroadSubscription(
  subsAllRef: Ref.Ref<ReadonlyArray<LiveBroadSubscription>>,
  id: SubscriptionId,
): Effect.Effect<void> {
  return Ref.update(subsAllRef, (subscriptions) =>
    subscriptions.filter((subscription) => subscription.id !== id),
  );
}

function dispatchToBroadSubscriber(
  sub: LiveBroadSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onFrame(frame)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("subscribeAll onFrame callback threw", err),
    ),
  );
}

function closeBroadSubscriber(
  sub: LiveBroadSubscription,
  cause: NotConnectedError,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onClose(cause)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("subscribeAll onClose callback threw", err),
    ),
  );
}

/**
 * Single named typed→erased adapter for the refinement predicate. The
 * `Stream.async` callback inside `notification/stream.ts` keeps the typed
 * shape for the consumer's typed payload; storage in `LiveSubscription`
 * uses the broad-union erased form. This is the only place the typed →
 * erased boundary crosses, so the cast is acknowledged with an explicit
 * lint suppression.
 */
function eraseRefinement<D extends AnyNotificationDefinition>(
  refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
): ErasedNotificationRefinement | undefined {
  if (refinement === undefined) return undefined;
  // The typed→erased boundary is by construction safe: the registry's
  // `dispatch` loop only invokes the refinement with frames whose
  // `definition === sub.definition`, so `frame.params` always satisfies
  // `NotificationParamsOf<D>`.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- documented typed→erased boundary, see comment above
  return refinement as unknown as ErasedNotificationRefinement; // #ignore-sloppy-code[as-unknown-as]: typed→erased boundary for heterogeneous registry storage; dispatch loop enforces definition identity before invocation
}

function buildRegister(
  subsRef: Ref.Ref<ReadonlyArray<LiveSubscription>>,
  counterRef: Ref.Ref<number>,
): SubscriberRegistry["register"] {
  return (definition, refinement, callbacks) =>
    Effect.gen(function* () {
      const id = yield* nextSubscriptionId(counterRef);
      const erasedRefinement = eraseRefinement(refinement);
      const live: LiveSubscription = {
        id,
        definition,
        ...(erasedRefinement !== undefined
          ? { refinement: erasedRefinement }
          : {}),
        onFrame: callbacks.onFrame as SubscriberFrameCallback,
        onClose: callbacks.onClose,
      };
      yield* appendSubscription(subsRef, live);
      const unregister = removeSubscription(subsRef, id);
      return { id, unregister };
    });
}

function buildRegisterAll(
  subsAllRef: Ref.Ref<ReadonlyArray<LiveBroadSubscription>>,
  counterRef: Ref.Ref<number>,
): SubscriberRegistry["registerAll"] {
  return (refinement, callbacks) =>
    Effect.gen(function* () {
      const id = yield* nextSubscriptionId(counterRef);
      const live: LiveBroadSubscription = {
        id,
        ...(refinement !== undefined ? { refinement } : {}),
        onFrame: callbacks.onFrame,
        onClose: callbacks.onClose,
      };
      yield* appendBroadSubscription(subsAllRef, live);
      const unregister = removeBroadSubscription(subsAllRef, id);
      return { id, unregister };
    });
}

/**
 * Run a user-supplied refinement predicate with throw isolation. A throw
 * inside the predicate must NOT defect the dispatch Effect (which would
 * starve sibling subscribers of the in-flight frame, AD1 path-(a) snapshot
 * contract). Treat any throw as "predicate said false" — the frame is
 * filtered out for this subscriber, the throw is logged, dispatch
 * continues with the next subscription in the snapshot.
 *
 * The warning is emitted via `Effect.runFork(Effect.logWarning(…))`
 * (detached from the dispatch fiber's span/annotations) so the
 * synchronous filter returned by `subAcceptsFrame` / `broadAcceptsFrame`
 * stays synchronous — pulling logging into the surrounding `Effect.gen`
 * would either (a) require the predicate to become an Effect (forcing
 * every caller to `yield*`) or (b) accumulate warnings in a Ref and
 * re-emit post-dispatch (extra state for a non-load-bearing log). The
 * detached log is acceptable for predicate misuse — a noisy warning
 * that names the call site (`subscribe` vs `subscribeAll`) is sufficient
 * signal for the application author to find the throw in their
 * refinement. Codex r2 P3-1 documented this trade-off rather than
 * restructuring.
 */
function safePredicate<P>(
  predicate: (params: P) => boolean,
  params: P,
  context: string,
): boolean {
  try {
    return predicate(params);
  } catch (err) {
    Effect.runFork(
      Effect.logWarning(`${context} refinement predicate threw`, err),
    );
    return false;
  }
}

/**
 * Cognitive-complexity helper: decides whether a per-definition sub
 * accepts a given frame. Predicate throws are caught (P2-1, codex r1):
 * a throwing refinement returns `false` rather than defecting the
 * dispatch Effect.
 */
function subAcceptsFrame(
  sub: LiveSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): boolean {
  if (sub.definition !== frame.definition) return false;
  if (
    sub.refinement !== undefined &&
    !safePredicate(sub.refinement, frame.params, "subscribe")
  )
    return false;
  return true;
}

/** Same as `subAcceptsFrame`, but for broad-union subscriptions. */
function broadAcceptsFrame(
  sub: LiveBroadSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): boolean {
  return (
    sub.refinement === undefined ||
    safePredicate(sub.refinement, frame, "subscribeAll")
  );
}

function buildDispatch(
  subsRef: Ref.Ref<ReadonlyArray<LiveSubscription>>,
  subsAllRef: Ref.Ref<ReadonlyArray<LiveBroadSubscription>>,
): SubscriberRegistry["dispatch"] {
  return (frame) =>
    Effect.gen(function* () {
      // Snapshot both lists at iteration start (AD1 path-(a) semantic).
      const snapshot = yield* Ref.get(subsRef);
      const broadSnapshot = yield* Ref.get(subsAllRef);
      const matching = snapshot.filter((sub) => subAcceptsFrame(sub, frame));
      for (const sub of matching) {
        yield* dispatchToSubscriber(sub, frame);
      }
      const matchingBroad = broadSnapshot.filter((sub) =>
        broadAcceptsFrame(sub, frame),
      );
      for (const sub of matchingBroad) {
        yield* dispatchToBroadSubscriber(sub, frame);
      }
    });
}

function buildCloseAll(
  subsRef: Ref.Ref<ReadonlyArray<LiveSubscription>>,
  subsAllRef: Ref.Ref<ReadonlyArray<LiveBroadSubscription>>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.getAndSet(
      subsRef,
      [] as ReadonlyArray<LiveSubscription>,
    );
    const broadSnapshot = yield* Ref.getAndSet(
      subsAllRef,
      [] as ReadonlyArray<LiveBroadSubscription>,
    );
    const cause = new NotConnectedError({
      message: "WebSocket not connected",
    });
    for (const sub of snapshot) {
      yield* closeSubscriber(sub, cause);
    }
    for (const sub of broadSnapshot) {
      yield* closeBroadSubscriber(sub, cause);
    }
  });
}

export function makeSubscriberRegistry(): Effect.Effect<
  SubscriberRegistry,
  never
> {
  return Effect.gen(function* () {
    const subsRef = yield* Ref.make<ReadonlyArray<LiveSubscription>>([]);
    const subsAllRef = yield* Ref.make<ReadonlyArray<LiveBroadSubscription>>(
      [],
    );
    const counterRef = yield* Ref.make(0);
    return {
      register: buildRegister(subsRef, counterRef),
      registerAll: buildRegisterAll(subsAllRef, counterRef),
      dispatch: buildDispatch(subsRef, subsAllRef),
      closeAll: buildCloseAll(subsRef, subsAllRef),
    };
  }).pipe(Effect.withSpan("makeSubscriberRegistry"));
}
