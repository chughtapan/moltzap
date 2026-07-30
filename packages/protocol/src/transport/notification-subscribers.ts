import { Brand, Cause, Effect, Ref, Stream } from "effect";
import {
  isNotificationDeliveryFor,
  type NotificationDefinitionAny,
  type NotificationDelivery,
  type NotificationParamsOf,
} from "./definition.js";

type AnyNotificationDescriptor = NotificationDefinitionAny;

type SubscriptionId = string & Brand.Brand<"NotificationSubscriptionId">;
const SubscriptionIdBrand = Brand.nominal<SubscriptionId>();

type SubscriberDeliveryCallback = (
  delivery: NotificationDelivery,
) => Effect.Effect<void>;

type DeliveryOf<Definitions extends AnyNotificationDescriptor> =
  NotificationDelivery<Definitions>;

type BroadSubscriberFrameCallback<
  Definitions extends AnyNotificationDescriptor,
> = (delivery: DeliveryOf<Definitions>) => Effect.Effect<void>;

type SubscriberCloseCallback<CloseError> = (
  cause: CloseError,
) => Effect.Effect<void>;

interface LiveSubscription<CloseError> {
  readonly id: SubscriptionId;
  readonly accepts: (delivery: NotificationDelivery) => boolean;
  readonly onFrame: SubscriberDeliveryCallback;
  readonly onClose: SubscriberCloseCallback<CloseError>;
}

interface LiveBroadSubscription<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
> {
  readonly id: SubscriptionId;
  readonly refinement?: (delivery: DeliveryOf<Definitions>) => boolean;
  readonly onFrame: BroadSubscriberFrameCallback<Definitions>;
  readonly onClose: SubscriberCloseCallback<CloseError>;
}

/** Describes notification subscription handle. */
export interface NotificationSubscriptionHandle {
  readonly id: string;
  readonly unregister: Effect.Effect<void>;
}

/** Describes notification subscriber registry. */
export interface NotificationSubscriberRegistry<
  CloseError,
  Definitions extends AnyNotificationDescriptor = AnyNotificationDescriptor,
> {
  readonly register: <D extends Definitions>(
    definition: D,
    callbacks: {
      readonly onFrame: (
        params: NotificationParamsOf<D>,
      ) => Effect.Effect<void>;
      readonly onClose: SubscriberCloseCallback<CloseError>;
    },
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ) => Effect.Effect<NotificationSubscriptionHandle>;

  readonly registerAll: (
    callbacks: {
      readonly onFrame: BroadSubscriberFrameCallback<Definitions>;
      readonly onClose: SubscriberCloseCallback<CloseError>;
    },
    refinement?: (delivery: DeliveryOf<Definitions>) => boolean,
  ) => Effect.Effect<NotificationSubscriptionHandle>;

  readonly dispatch: (delivery: DeliveryOf<Definitions>) => Effect.Effect<void>;

  readonly closeAll: Effect.Effect<void>;
}

/** Configures notification subscriber registry. */
export interface NotificationSubscriberRegistryOptions<CloseError> {
  readonly closeCause: () => CloseError;
  readonly logPrefix?: string;
  readonly spanName?: string;
}

interface NotificationSubscriberRegistryState<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
> {
  readonly logPrefix: string;
  readonly subsRef: Ref.Ref<ReadonlyArray<LiveSubscription<CloseError>>>;
  readonly subsAllRef: Ref.Ref<
    ReadonlyArray<LiveBroadSubscription<CloseError, Definitions>>
  >;
  readonly counterRef: Ref.Ref<number>;
  readonly closeCause: () => CloseError;
}

function nextSubscriptionId(
  counterRef: Ref.Ref<number>,
): Effect.Effect<SubscriptionId> {
  return Ref.updateAndGet(counterRef, (count) => count + 1).pipe(
    Effect.map((count) => SubscriptionIdBrand(`notification-sub-${count}`)),
  );
}

function removeSubscription<T extends { readonly id: SubscriptionId }>(
  ref: Ref.Ref<readonly T[]>,
  id: SubscriptionId,
): Effect.Effect<void> {
  return Ref.update(ref, (subscriptions) =>
    subscriptions.filter((subscription) => subscription.id !== id),
  );
}

function safePredicate<P>(
  predicate: (params: P) => boolean,
  params: P,
  context: string,
  logPrefix: string,
): boolean {
  try {
    return predicate(params);
  } catch (err) {
    Effect.runFork(
      Effect.logWarning(
        `${logPrefix} ${context} refinement predicate threw`,
        err,
      ),
    );
    return false;
  }
}

/**
 * Run one subscriber callback, demoting any defect it throws to a warning so a
 * single misbehaving subscriber cannot tear down the dispatch loop.
 * @param run Value supplied to the operation.
 * @param logMessage Value supplied to the operation.
 * @returns The guard callback result.
 */
function guardCallback(
  run: () => Effect.Effect<void>,
  logMessage: string,
): Effect.Effect<void> {
  return Effect.suspend(run).pipe(
    Effect.catchAllDefect((err) => Effect.logWarning(logMessage, err)),
  );
}

function dispatchToSubscriber<CloseError>(
  sub: LiveSubscription<CloseError>,
  delivery: NotificationDelivery,
  logPrefix: string,
): Effect.Effect<void> {
  return guardCallback(
    () => sub.onFrame(delivery),
    `${logPrefix} onFrame callback threw`,
  );
}

function dispatchToBroadSubscriber<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  sub: LiveBroadSubscription<CloseError, Definitions>,
  delivery: DeliveryOf<Definitions>,
  logPrefix: string,
): Effect.Effect<void> {
  return guardCallback(
    () => sub.onFrame(delivery),
    `${logPrefix} subscribeAll onFrame callback threw`,
  );
}

function closeSubscriber<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  sub:
    | LiveSubscription<CloseError>
    | LiveBroadSubscription<CloseError, Definitions>,
  cause: CloseError,
  logPrefix: string,
): Effect.Effect<void> {
  return guardCallback(
    () => sub.onClose(cause),
    `${logPrefix} onClose callback threw`,
  );
}

function broadAcceptsDelivery<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  sub: LiveBroadSubscription<CloseError, Definitions>,
  delivery: DeliveryOf<Definitions>,
  logPrefix: string,
): boolean {
  if (sub.refinement === undefined) {
    return true;
  }
  return safePredicate(sub.refinement, delivery, "subscribeAll", logPrefix);
}

function registerSubscription<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
  D extends Definitions,
>(
  state: NotificationSubscriberRegistryState<CloseError, Definitions>,
  definition: D,
  callbacks: {
    readonly onFrame: (params: NotificationParamsOf<D>) => Effect.Effect<void>;
    readonly onClose: SubscriberCloseCallback<CloseError>;
  },
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Effect.Effect<NotificationSubscriptionHandle> {
  return Effect.gen(function* () {
    const id = yield* nextSubscriptionId(state.counterRef);
    const live: LiveSubscription<CloseError> = {
      id,
      accepts: (delivery) => {
        if (!isNotificationDeliveryFor(delivery, definition)) {
          return false;
        }
        if (refinement === undefined) {
          return true;
        }
        return safePredicate(
          refinement,
          delivery.params,
          "subscribe",
          state.logPrefix,
        );
      },
      onFrame: (delivery) => {
        if (!isNotificationDeliveryFor(delivery, definition)) {
          return Effect.void;
        }
        return callbacks.onFrame(delivery.params);
      },
      onClose: callbacks.onClose,
    };
    yield* Ref.update(state.subsRef, (subscriptions) => [
      ...subscriptions,
      live,
    ]);
    return { id, unregister: removeSubscription(state.subsRef, id) };
  });
}

function registerBroadSubscription<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  state: NotificationSubscriberRegistryState<CloseError, Definitions>,
  callbacks: {
    readonly onFrame: BroadSubscriberFrameCallback<Definitions>;
    readonly onClose: SubscriberCloseCallback<CloseError>;
  },
  refinement?: (delivery: DeliveryOf<Definitions>) => boolean,
): Effect.Effect<NotificationSubscriptionHandle> {
  return Effect.gen(function* () {
    const id = yield* nextSubscriptionId(state.counterRef);
    const live: LiveBroadSubscription<CloseError, Definitions> = {
      id,
      ...(refinement !== undefined ? { refinement } : {}),
      onFrame: callbacks.onFrame,
      onClose: callbacks.onClose,
    };
    yield* Ref.update(state.subsAllRef, (subscriptions) => [
      ...subscriptions,
      live,
    ]);
    return { id, unregister: removeSubscription(state.subsAllRef, id) };
  });
}

function dispatchDelivery<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  state: NotificationSubscriberRegistryState<CloseError, Definitions>,
  delivery: DeliveryOf<Definitions>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.get(state.subsRef);
    const broadSnapshot = yield* Ref.get(state.subsAllRef);
    for (const sub of snapshot) {
      if (sub.accepts(delivery)) {
        yield* dispatchToSubscriber(sub, delivery, state.logPrefix);
      }
    }
    for (const sub of broadSnapshot) {
      if (broadAcceptsDelivery(sub, delivery, state.logPrefix)) {
        yield* dispatchToBroadSubscriber(sub, delivery, state.logPrefix);
      }
    }
  });
}

function closeSubscriptions<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  state: NotificationSubscriberRegistryState<CloseError, Definitions>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const snapshot = yield* Ref.getAndSet(state.subsRef, []);
    const broadSnapshot = yield* Ref.getAndSet(state.subsAllRef, []);
    const cause = state.closeCause();
    for (const sub of snapshot) {
      yield* closeSubscriber(sub, cause, state.logPrefix);
    }
    for (const sub of broadSnapshot) {
      yield* closeSubscriber(sub, cause, state.logPrefix);
    }
  });
}

/**
 * Creates notification subscriber registry.
 * @param options Options that control the operation.
 * @returns The created notification subscriber registry.
 */
export function makeNotificationSubscriberRegistry<
  CloseError,
  Definitions extends AnyNotificationDescriptor = AnyNotificationDescriptor,
>(
  options: NotificationSubscriberRegistryOptions<CloseError>,
): Effect.Effect<NotificationSubscriberRegistry<CloseError, Definitions>> {
  return Effect.gen(function* () {
    const logPrefix = options.logPrefix ?? "notification subscriber";
    const subsRef = yield* Ref.make<
      ReadonlyArray<LiveSubscription<CloseError>>
    >([]);
    const subsAllRef = yield* Ref.make<
      ReadonlyArray<LiveBroadSubscription<CloseError, Definitions>>
    >([]);
    const counterRef = yield* Ref.make(0);
    const state: NotificationSubscriberRegistryState<CloseError, Definitions> =
      {
        logPrefix,
        subsRef,
        subsAllRef,
        counterRef,
        closeCause: options.closeCause,
      };

    const registry: NotificationSubscriberRegistry<CloseError, Definitions> = {
      register: (definition, callbacks, refinement) =>
        registerSubscription(state, definition, callbacks, refinement),
      registerAll: (callbacks, refinement) =>
        registerBroadSubscription(state, callbacks, refinement),
      dispatch: (delivery: DeliveryOf<Definitions>) =>
        dispatchDelivery(state, delivery),
      closeAll: closeSubscriptions(state),
    };
    return registry;
  }).pipe(
    Effect.withSpan(options.spanName ?? "makeNotificationSubscriberRegistry"),
  );
}

export function notificationSubscribe<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
  D extends Definitions,
  R extends NotificationParamsOf<D>,
>(
  registry: NotificationSubscriberRegistry<CloseError, Definitions>,
  definition: D,
  refinement: (params: NotificationParamsOf<D>) => params is R,
): Stream.Stream<R, CloseError>;
export function notificationSubscribe<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
  D extends Definitions,
>(
  registry: NotificationSubscriberRegistry<CloseError, Definitions>,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, CloseError>;
/**
 * Executes the notification subscribe operation.
 * @param registry Value supplied to the operation.
 * @param definition Protocol definition to process.
 * @param refinement Value supplied to the operation.
 * @returns The notification subscribe result.
 */
export function notificationSubscribe<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
  D extends Definitions,
>(
  registry: NotificationSubscriberRegistry<CloseError, Definitions>,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, CloseError> {
  return Stream.async<NotificationParamsOf<D>, CloseError>((emit) => {
    const handle = Effect.runSync(
      registry.register(
        definition,
        {
          onFrame: (params) =>
            Effect.tryPromise({
              try: () => emit.single(params),
              catch: (cause) => new Cause.UnknownException(cause),
            }).pipe(Effect.orDie),
          onClose: (cause) =>
            Effect.promise(() => emit.fail(cause)).pipe(Effect.asVoid),
        },
        refinement,
      ),
    );
    return Effect.suspend(() => handle.unregister);
  });
}

/**
 * Executes the notification subscribe all operation.
 * @param registry Value supplied to the operation.
 * @param refinement Value supplied to the operation.
 * @returns The notification subscribe all result.
 */
export function notificationSubscribeAll<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  registry: NotificationSubscriberRegistry<CloseError, Definitions>,
  refinement?: (delivery: DeliveryOf<Definitions>) => boolean,
): Stream.Stream<DeliveryOf<Definitions>, CloseError> {
  return Stream.async<DeliveryOf<Definitions>, CloseError>((emit) => {
    const handle = Effect.runSync(
      registry.registerAll(
        {
          onFrame: (delivery) =>
            Effect.tryPromise({
              try: () => emit.single(delivery),
              catch: (cause) => new Cause.UnknownException(cause),
            }).pipe(Effect.orDie),
          onClose: (cause) =>
            Effect.promise(() => emit.fail(cause)).pipe(Effect.asVoid),
        },
        refinement,
      ),
    );
    return Effect.suspend(() => handle.unregister);
  });
}
