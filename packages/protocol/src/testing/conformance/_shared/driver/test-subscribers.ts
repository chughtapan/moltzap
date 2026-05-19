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
 * `packages/protocol/docs/architecture/11-test-client-stream-consolidation.md
 * → §2 "Why the registry can't be shared"`.
 */
import { Effect, Stream } from "effect";
import type { AnyNotificationDefinition } from "../../../../rpc-registry.js";
import type { DecodedNotification } from "../../../../transport/rpc-groups.js";
import type { NotificationParamsOf } from "../../../../transport/method.js";
import { TransportClosedError } from "../errors.js";

const ARCHITECT_STUB = "architect stub (#645) — impl lands the body";

/**
 * Erased refinement predicate type stored on `LiveTestSubscription`
 * (impl). Per-definition subscriptions bind it to the definition's
 * params shape; the broad-union `subscribeAll` form binds it to the
 * full `DecodedNotification<AnyNotificationDefinition>` shape. Storage
 * uses the broader union for heterogeneous iteration.
 */
type SubscriberFrameCallback = (
  frame: DecodedNotification<AnyNotificationDefinition>,
) => Effect.Effect<void, never>;

type SubscriberCloseCallback = (
  cause: TransportClosedError,
) => Effect.Effect<void, never>;

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

/**
 * Construct an empty registry. Called once from
 * `acquireTestClientRuntime` after the socket is acquired so its
 * `Effect.addFinalizer(closeAll)` runs LIFO BEFORE the socket reader
 * finalizer — consumers see `emit.fail(TransportClosedError)` before
 * the transport tears down.
 *
 * Architect stub: returns `Effect.die(ARCHITECT_STUB)`. The Effect
 * defect surfaces only at materialisation time (no caller can run
 * this Effect today without seeing the stub message). Impl flips the
 * body to the registry construction.
 */
export function makeTestSubscriberRegistry(): Effect.Effect<
  TestSubscriberRegistry,
  never
> {
  return Effect.die(ARCHITECT_STUB);
}

/**
 * Typed-payload subscribe. Returns a `Stream` whose error channel is
 * `TransportClosedError` and requirement set is `never`. The Stream
 * value is pure; materialisation installs the registry callbacks.
 *
 * The type-guard overload narrows the Stream's payload to
 * `DecodedNotification<D, R>`.
 *
 * Architect stub body returns `Stream.die(ARCHITECT_STUB)`. The
 * defect surfaces at pull time, not at Stream construction.
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
  _registry: TestSubscriberRegistry,
  _definition: D,
  _refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
  return Stream.die(ARCHITECT_STUB);
}

/**
 * Broad-union subscribe. Returns a `Stream` of every inbound
 * notification regardless of definition. Used by conformance helpers
 * that need to filter on params-shaped predicates not expressible at
 * the definition level (e.g. presence/changed by agentId+status).
 *
 * Architect stub body returns `Stream.die(ARCHITECT_STUB)`.
 */
export function subscribeAll(
  _registry: TestSubscriberRegistry,
  _refinement?: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => boolean,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  TransportClosedError
> {
  return Stream.die(ARCHITECT_STUB);
}
