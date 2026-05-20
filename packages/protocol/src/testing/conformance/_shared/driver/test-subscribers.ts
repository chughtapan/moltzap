/* eslint-disable jsdoc/text-escaping -- JSDoc references to generic types like `Stream.async<DecodedNotification<D>>` use the natural angle-bracket form inside backtick spans; matches the precedent in @moltzap/client's notification/stream.ts. */

/**
 * Per-`TestClient` subscriber registry + Stream constructors.
 *
 * Mirrors the production `MoltZapWsClient` shape established by Spec B
 * (#596): a typed callback registry that fans each inbound notification
 * out to every live `Stream.async`-backed consumer. The test driver's
 * registry is the protocol-side analog of
 * `packages/client/src/runtime/subscribers.ts` +
 * `packages/client/src/notification/stream.ts`, with two intentional
 * differences:
 *
 * 1. Error channel. Streams fail with `TransportClosedError` (the test
 *    driver's terminal-close tag), not `NotConnectedError` (the
 *    production client's).
 * 2. Storage shape. The registry tracks broad-union `subscribeAll`
 *    subscriptions in the SAME `subsRef` list as per-definition
 *    subscriptions, distinguished by a `definition: null` sentinel.
 *    No separate `subsAllRef`. Test-side dispatch is a single iteration
 *    over one list; production's dispatch is two lists because the
 *    service-wide fan-out fiber needs broad-union storage hot-path
 *    separation.
 *
 * Otherwise the contract is identical: dispatch snapshots `subsRef` at
 * iteration start (AD1 path-(a) snapshot semantic from spec #222
 * §5.3 OQ-3 / spec #596 "Stream lifecycle contract" row); `closeAll`
 * invokes each live sub's `onClose(new TransportClosedError(...))`
 * before clearing the ref; the per-sub `unregister` Effect is the
 * `Stream.async` cancellation finalizer.
 *
 * Architect-tier rationale for not sharing the production registry:
 * `@moltzap/protocol` is the leaf workspace package and cannot import
 * from `@moltzap/client`. Parameterising the production registry by
 * error type to host it in protocol-side would carry roughly the same
 * cost as a leaner test-side copy; see
 * `packages/protocol/docs/architecture/test-client-stream-consolidation.md
 * → §2 "Why the registry can't be shared"`.
 */
import { Brand, Effect, Ref, Stream } from "effect";
import type { AnyNotificationDefinition } from "../../../../rpc-registry.js";
import type { DecodedNotification } from "../../../../transport/rpc-groups.js";
import type { NotificationParamsOf } from "../../../../transport/method.js";
import { TransportClosedError } from "../errors.js";

/** Branded identifier for a subscription handle. Minted by `register`. */
type SubscriptionId = string & Brand.Brand<"TestSubscriptionId">;
const SubscriptionIdBrand = Brand.nominal<SubscriptionId>();

/**
 * Erased refinement predicate type stored on `LiveTestSubscription`.
 * Per-definition subscriptions bind it to the definition's params shape;
 * the broad-union `subscribeAll` form binds it to the full
 * `DecodedNotification<AnyNotificationDefinition>` shape. Storage uses
 * the broader union for heterogeneous iteration. Mirrors the production
 * registry's `ErasedNotificationRefinement` shape.
 */
type ErasedPerDefRefinement = (
  params: NotificationParamsOf<AnyNotificationDefinition>,
) => boolean;

type ErasedBroadRefinement = (
  notification: DecodedNotification<AnyNotificationDefinition>,
) => boolean;

type SubscriberFrameCallback = (
  frame: DecodedNotification<AnyNotificationDefinition>,
) => Effect.Effect<void, never>;

type SubscriberCloseCallback = (
  cause: TransportClosedError,
) => Effect.Effect<void, never>;

/**
 * Live subscription record stored in `subsRef`. `definition === null`
 * marks a broad-union subscription registered via `registerAll`; the
 * dispatch loop matches every frame for those rows after the optional
 * refinement filter.
 */
interface LiveTestSubscription {
  readonly id: SubscriptionId;
  /** `null` sentinel for broad-union (`registerAll`) rows. */
  readonly definition: AnyNotificationDefinition | null;
  readonly refinement?: ErasedPerDefRefinement | ErasedBroadRefinement;
  readonly onFrame: SubscriberFrameCallback;
  readonly onClose: SubscriberCloseCallback;
}

/**
 * Handle returned by `register` / `registerAll`. `unregister` is
 * `Effect<void, never>`: idempotent and total. The `Stream.async`
 * cancellation finalizer invokes it; a duplicate call after
 * `closeAll` is a no-op.
 */
export interface TestSubscriptionHandle {
  readonly id: string;
  readonly unregister: Effect.Effect<void, never>;
}

/**
 * Subscriber registry. One instance per `TestClientRuntime`.
 *
 * - `register<D>` accepts typed `onFrame` / `onClose` callbacks for the
 *   specific definition `D`; storage erases callbacks to the union shape.
 * - `registerAll` accepts callbacks against the broad-union
 *   `DecodedNotification<AnyNotificationDefinition>` shape; storage
 *   parks a `definition: null` sentinel record in the same list.
 * - `dispatch` snapshots `subsRef` at iteration start; per-definition
 *   subs match on `sub.definition === frame.definition`, broad-union
 *   subs match unconditionally; optional `refinement` runs after the
 *   definition gate.
 * - `closeAll` invokes each live sub's onClose with a
 *   `TransportClosedError` before clearing `subsRef`. Idempotent.
 */
export interface TestSubscriberRegistry {
  readonly register: <D extends AnyNotificationDefinition>(
    definition: D,
    refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
    callbacks: {
      readonly onFrame: (
        frame: DecodedNotification<D>,
      ) => Effect.Effect<void, never>;
      readonly onClose: SubscriberCloseCallback;
    },
  ) => Effect.Effect<TestSubscriptionHandle, never>;

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
  ) => Effect.Effect<TestSubscriptionHandle, never>;

  readonly dispatch: (
    frame: DecodedNotification<AnyNotificationDefinition>,
  ) => Effect.Effect<void, never>;

  readonly closeAll: Effect.Effect<void, never>;
}

function nextSubscriptionId(
  counterRef: Ref.Ref<number>,
): Effect.Effect<SubscriptionId> {
  return Ref.updateAndGet(counterRef, (count) => count + 1).pipe(
    Effect.map((count) => SubscriptionIdBrand(`test-sub-${count}`)),
  );
}

function appendSubscription(
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
  live: LiveTestSubscription,
): Effect.Effect<void> {
  return Ref.update(subsRef, (subscriptions) => [...subscriptions, live]);
}

function removeSubscription(
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
  id: SubscriptionId,
): Effect.Effect<void> {
  return Ref.update(subsRef, (subscriptions) =>
    subscriptions.filter((subscription) => subscription.id !== id),
  );
}

function dispatchToSubscriber(
  sub: LiveTestSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onFrame(frame)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("test subscriber onFrame callback threw", err),
    ),
  );
}

function closeSubscriber(
  sub: LiveTestSubscription,
  cause: TransportClosedError,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onClose(cause)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning("test subscriber onClose callback threw", err),
    ),
  );
}

/**
 * Single named typed→erased adapter for the refinement predicate. The
 * `Stream.async` callback in `subscribe`/`subscribeAll` keeps the typed
 * shape for the consumer; storage in `LiveTestSubscription` uses the
 * broad-union erased form. This is the only place the typed → erased
 * boundary crosses, so the cast is acknowledged with an explicit lint
 * suppression. Mirrors production `subscribers.ts → eraseRefinement`.
 */
function erasePerDefRefinement<D extends AnyNotificationDefinition>(
  refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
): ErasedPerDefRefinement | undefined {
  if (refinement === undefined) return undefined;
  // The typed→erased boundary is safe by construction: the registry's
  // `dispatch` loop only invokes the refinement with frames whose
  // `definition === sub.definition`, so `frame.params` always satisfies
  // `NotificationParamsOf<D>`.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- documented typed→erased boundary, see comment above
  return refinement as unknown as ErasedPerDefRefinement; // #ignore-sloppy-code[as-unknown-as]: typed→erased boundary for heterogeneous registry storage; dispatch loop enforces definition identity before invocation
}

/**
 * Run a user-supplied refinement predicate with throw isolation. A throw
 * inside the predicate must NOT defect the dispatch Effect (which would
 * starve sibling subscribers of the in-flight frame, AD1 path-(a)
 * snapshot contract). Treat any throw as "predicate said false" — the
 * frame is filtered out for this subscriber, the throw is logged,
 * dispatch continues with the next subscription in the snapshot.
 *
 * Mirrors production `subscribers.ts → safePredicate`; the detached
 * `Effect.runFork(Effect.logWarning(…))` form is intentional — keeps
 * the synchronous filter inside `subAcceptsFrame` synchronous without
 * forcing the predicate to become an Effect or accumulating warnings
 * in a Ref.
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
      Effect.logWarning(`test ${context} refinement predicate threw`, err),
    );
    return false;
  }
}

/**
 * Decides whether a subscription accepts a given frame. Per-definition
 * subs match on `sub.definition === frame.definition` AND the optional
 * refinement; broad-union subs (`definition === null`) match the frame
 * unconditionally except for the optional refinement (which sees the
 * full `DecodedNotification` shape, not just params).
 */
function subAcceptsFrame(
  sub: LiveTestSubscription,
  frame: DecodedNotification<AnyNotificationDefinition>,
): boolean {
  if (sub.definition === null) {
    // Broad-union (`registerAll`) sentinel row: refinement (if any)
    // takes the full frame.
    if (sub.refinement === undefined) return true;
    return safePredicate(
      sub.refinement as ErasedBroadRefinement,
      frame,
      "subscribeAll",
    );
  }
  if (sub.definition !== frame.definition) return false;
  if (sub.refinement === undefined) return true;
  return safePredicate(
    sub.refinement as ErasedPerDefRefinement,
    frame.params,
    "subscribe",
  );
}

function buildRegister(
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
  counterRef: Ref.Ref<number>,
): TestSubscriberRegistry["register"] {
  return (definition, refinement, callbacks) =>
    Effect.gen(function* () {
      const id = yield* nextSubscriptionId(counterRef);
      const erasedRefinement = erasePerDefRefinement(refinement);
      const live: LiveTestSubscription = {
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
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
  counterRef: Ref.Ref<number>,
): TestSubscriberRegistry["registerAll"] {
  return (refinement, callbacks) =>
    Effect.gen(function* () {
      const id = yield* nextSubscriptionId(counterRef);
      const live: LiveTestSubscription = {
        id,
        definition: null,
        ...(refinement !== undefined ? { refinement } : {}),
        onFrame: callbacks.onFrame,
        onClose: callbacks.onClose,
      };
      yield* appendSubscription(subsRef, live);
      const unregister = removeSubscription(subsRef, id);
      return { id, unregister };
    });
}

function buildDispatch(
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
): TestSubscriberRegistry["dispatch"] {
  return (frame) =>
    Effect.gen(function* () {
      // Snapshot `subsRef` at iteration start (AD1 path-(a) semantic).
      const snapshot = yield* Ref.get(subsRef);
      const matching = snapshot.filter((sub) => subAcceptsFrame(sub, frame));
      for (const sub of matching) {
        yield* dispatchToSubscriber(sub, frame);
      }
    });
}

function buildCloseAll(
  subsRef: Ref.Ref<ReadonlyArray<LiveTestSubscription>>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.getAndSet(
      subsRef,
      [] as ReadonlyArray<LiveTestSubscription>,
    );
    const cause = new TransportClosedError({
      direction: "inbound",
      code: 1006,
      reason: "test client closed",
    });
    for (const sub of snapshot) {
      yield* closeSubscriber(sub, cause);
    }
  });
}

/**
 * Construct an empty registry. Called once from
 * `acquireTestClientRuntime` after the socket is acquired so its
 * `Effect.addFinalizer(closeAll)` runs LIFO BEFORE the socket reader
 * finalizer — consumers see `emit.fail(TransportClosedError)` before
 * the transport tears down.
 */
export function makeTestSubscriberRegistry(): Effect.Effect<
  TestSubscriberRegistry,
  never
> {
  return Effect.gen(function* () {
    const subsRef = yield* Ref.make<ReadonlyArray<LiveTestSubscription>>([]);
    const counterRef = yield* Ref.make(0);
    return {
      register: buildRegister(subsRef, counterRef),
      registerAll: buildRegisterAll(subsRef, counterRef),
      dispatch: buildDispatch(subsRef),
      closeAll: buildCloseAll(subsRef),
    };
  }).pipe(Effect.withSpan("makeTestSubscriberRegistry"));
}

/**
 * Typed-payload subscribe. Returns a `Stream` whose error channel is
 * `TransportClosedError` and requirement set is `never`. The Stream
 * value is pure; materialisation installs the registry callbacks.
 *
 * The type-guard overload narrows the Stream's payload to
 * `DecodedNotification<D, R>`.
 *
 * Lifecycle parity with production (`packages/client/src/notification/stream.ts`):
 *   - Construction is pure (no I/O).
 *   - Materialisation runs `registry.register` synchronously via
 *     `Effect.runSync` (Ref-only Effect; never yields).
 *   - Consumer pulls suspend inside `Stream.async`'s internal queue
 *     until dispatch fires `emit.single`.
 *   - Terminal close fires `emit.fail(TransportClosedError)` from the
 *     registry's `closeAll`.
 *   - Cancellation finalizer runs `handle.unregister` via
 *     `Effect.suspend` so future yielded effects inside `unregister`
 *     stay deferred (matches production P3 fix #613).
 */
export function subscribe<D extends AnyNotificationDefinition>(
  registry: TestSubscriberRegistry,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
export function subscribe<
  D extends AnyNotificationDefinition,
  R extends NotificationParamsOf<D>,
>(
  registry: TestSubscriberRegistry,
  definition: D,
  refinement: (params: NotificationParamsOf<D>) => params is R,
): Stream.Stream<DecodedNotification<D, R>, TransportClosedError>;
export function subscribe<D extends AnyNotificationDefinition>(
  registry: TestSubscriberRegistry,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
  return Stream.async<DecodedNotification<D>, TransportClosedError>((emit) => {
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
    return Effect.suspend(() => handle.unregister);
  });
}

/**
 * Broad-union subscribe. Returns a `Stream` of every inbound
 * notification regardless of definition. Used by conformance helpers
 * that need to filter on params-shaped predicates not expressible at
 * the definition level (e.g. presence/changed by agentId+status).
 */
export function subscribeAll(
  registry: TestSubscriberRegistry,
  refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  TransportClosedError
> {
  return Stream.async<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
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
