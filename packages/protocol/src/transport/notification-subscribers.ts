import { Brand, Effect, Ref, Stream } from "effect";
import { isNotificationDeliveryFor } from "./definition.js";
import type {
  NotificationDefinitionAny,
  NotificationDelivery,
  NotificationParamsOf,
} from "./definition.js";

type AnyNotificationDescriptor = NotificationDefinitionAny;

type SubscriptionId = string & Brand.Brand<"NotificationSubscriptionId">;
const SubscriptionIdBrand = Brand.nominal<SubscriptionId>();

type SubscriberDeliveryCallback = (
  delivery: NotificationDelivery,
) => Effect.Effect<void, never>;

type DeliveryOf<Definitions extends AnyNotificationDescriptor> =
  NotificationDelivery<Definitions>;

type BroadSubscriberFrameCallback<
  Definitions extends AnyNotificationDescriptor,
> = (delivery: DeliveryOf<Definitions>) => Effect.Effect<void, never>;

type SubscriberCloseCallback<CloseError> = (
  cause: CloseError,
) => Effect.Effect<void, never>;

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

export interface NotificationSubscriptionHandle {
  readonly id: string;
  readonly unregister: Effect.Effect<void, never>;
}

export interface NotificationSubscriberRegistry<
  CloseError,
  Definitions extends AnyNotificationDescriptor = AnyNotificationDescriptor,
> {
  readonly register: <D extends Definitions>(
    definition: D,
    refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
    callbacks: {
      readonly onFrame: (
        params: NotificationParamsOf<D>,
      ) => Effect.Effect<void, never>;
      readonly onClose: SubscriberCloseCallback<CloseError>;
    },
  ) => Effect.Effect<NotificationSubscriptionHandle, never>;

  readonly registerAll: (
    refinement: ((delivery: DeliveryOf<Definitions>) => boolean) | undefined,
    callbacks: {
      readonly onFrame: BroadSubscriberFrameCallback<Definitions>;
      readonly onClose: SubscriberCloseCallback<CloseError>;
    },
  ) => Effect.Effect<NotificationSubscriptionHandle, never>;

  readonly dispatch: (
    delivery: DeliveryOf<Definitions>,
  ) => Effect.Effect<void, never>;

  readonly closeAll: Effect.Effect<void, never>;
}

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
  ref: Ref.Ref<ReadonlyArray<T>>,
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
  if (sub.refinement === undefined) return true;
  return safePredicate(sub.refinement, delivery, "subscribeAll", logPrefix);
}

function registerSubscription<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
  D extends Definitions,
>(
  state: NotificationSubscriberRegistryState<CloseError, Definitions>,
  definition: D,
  refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
  callbacks: {
    readonly onFrame: (
      params: NotificationParamsOf<D>,
    ) => Effect.Effect<void, never>;
    readonly onClose: SubscriberCloseCallback<CloseError>;
  },
): Effect.Effect<NotificationSubscriptionHandle, never> {
  return Effect.gen(function* () {
    const id = yield* nextSubscriptionId(state.counterRef);
    const live: LiveSubscription<CloseError> = {
      id,
      accepts: (delivery) => {
        if (!isNotificationDeliveryFor(delivery, definition)) return false;
        if (refinement === undefined) return true;
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
  refinement: ((delivery: DeliveryOf<Definitions>) => boolean) | undefined,
  callbacks: {
    readonly onFrame: BroadSubscriberFrameCallback<Definitions>;
    readonly onClose: SubscriberCloseCallback<CloseError>;
  },
): Effect.Effect<NotificationSubscriptionHandle, never> {
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
): Effect.Effect<void, never> {
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
): Effect.Effect<void, never> {
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

export function makeNotificationSubscriberRegistry<
  CloseError,
  Definitions extends AnyNotificationDescriptor = AnyNotificationDescriptor,
>(
  options: NotificationSubscriberRegistryOptions<CloseError>,
): Effect.Effect<
  NotificationSubscriberRegistry<CloseError, Definitions>,
  never
> {
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
      register: (definition, refinement, callbacks) =>
        registerSubscription(state, definition, refinement, callbacks),
      registerAll: (refinement, callbacks) =>
        registerBroadSubscription(state, refinement, callbacks),
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
      registry.register(definition, refinement, {
        onFrame: (params) =>
          Effect.tryPromise({
            try: () => emit.single(params),
            catch: (cause) => cause,
          }).pipe(Effect.orDie),
        onClose: (cause) =>
          Effect.sync(() => emit.fail(cause)).pipe(Effect.asVoid),
      }),
    );
    return Effect.suspend(() => handle.unregister);
  });
}

export function notificationSubscribeAll<
  CloseError,
  Definitions extends AnyNotificationDescriptor,
>(
  registry: NotificationSubscriberRegistry<CloseError, Definitions>,
  refinement?: (delivery: DeliveryOf<Definitions>) => boolean,
): Stream.Stream<DeliveryOf<Definitions>, CloseError> {
  return Stream.async<DeliveryOf<Definitions>, CloseError>((emit) => {
    const handle = Effect.runSync(
      registry.registerAll(refinement, {
        onFrame: (delivery) =>
          Effect.tryPromise({
            try: () => emit.single(delivery),
            catch: (cause) => cause,
          }).pipe(Effect.orDie),
        onClose: (cause) =>
          Effect.sync(() => emit.fail(cause)).pipe(Effect.asVoid),
      }),
    );
    return Effect.suspend(() => handle.unregister);
  });
}
