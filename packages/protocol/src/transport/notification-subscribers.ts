import { Brand, Effect, Ref, Stream } from "effect";
import type { Schema } from "effect";
import type {
  NotificationDefinition,
  NotificationDelivery,
  NotificationParamsOf,
} from "./method.js";

type AnyNotificationDescriptor = NotificationDefinition<
  string,
  Schema.Schema.AnyNoContext
>;

type SubscriptionId = string & Brand.Brand<"NotificationSubscriptionId">;
const SubscriptionIdBrand = Brand.nominal<SubscriptionId>();

type ErasedNotificationRefinement = (
  params: NotificationParamsOf<AnyNotificationDescriptor>,
) => boolean;

type SubscriberFrameCallback = (
  params: NotificationParamsOf<AnyNotificationDescriptor>,
) => Effect.Effect<void, never>;

type BroadSubscriberFrameCallback = (
  delivery: NotificationDelivery,
) => Effect.Effect<void, never>;

type SubscriberCloseCallback<CloseError> = (
  cause: CloseError,
) => Effect.Effect<void, never>;

interface LiveSubscription<CloseError> {
  readonly id: SubscriptionId;
  readonly definition: AnyNotificationDescriptor;
  readonly refinement?: ErasedNotificationRefinement;
  readonly onFrame: SubscriberFrameCallback;
  readonly onClose: SubscriberCloseCallback<CloseError>;
}

interface LiveBroadSubscription<CloseError> {
  readonly id: SubscriptionId;
  readonly refinement?: (delivery: NotificationDelivery) => boolean;
  readonly onFrame: BroadSubscriberFrameCallback;
  readonly onClose: SubscriberCloseCallback<CloseError>;
}

export interface NotificationSubscriptionHandle {
  readonly id: string;
  readonly unregister: Effect.Effect<void, never>;
}

export interface NotificationSubscriberRegistry<CloseError> {
  readonly register: <D extends AnyNotificationDescriptor>(
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
    refinement: ((delivery: NotificationDelivery) => boolean) | undefined,
    callbacks: {
      readonly onFrame: BroadSubscriberFrameCallback;
      readonly onClose: SubscriberCloseCallback<CloseError>;
    },
  ) => Effect.Effect<NotificationSubscriptionHandle, never>;

  readonly dispatch: (
    delivery: NotificationDelivery,
  ) => Effect.Effect<void, never>;

  readonly closeAll: Effect.Effect<void, never>;
}

export interface NotificationSubscriberRegistryOptions<CloseError> {
  readonly closeCause: () => CloseError;
  readonly logPrefix?: string;
  readonly spanName?: string;
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

function eraseRefinement<D extends AnyNotificationDescriptor>(
  refinement: ((params: NotificationParamsOf<D>) => boolean) | undefined,
): ErasedNotificationRefinement | undefined {
  if (refinement === undefined) return undefined;
  // The registry invokes this only after `delivery.definition === sub.definition`.
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- documented typed-erased boundary enforced by definition identity
  return refinement as unknown as ErasedNotificationRefinement; // #ignore-sloppy-code[as-unknown-as]: heterogeneous subscription storage; dispatch gates by descriptor identity.
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
      Effect.logWarning(`${logPrefix} ${context} refinement predicate threw`, err),
    );
    return false;
  }
}

function dispatchToSubscriber<CloseError>(
  sub: LiveSubscription<CloseError>,
  params: NotificationParamsOf<AnyNotificationDescriptor>,
  logPrefix: string,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onFrame(params)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning(`${logPrefix} onFrame callback threw`, err),
    ),
  );
}

function dispatchToBroadSubscriber<CloseError>(
  sub: LiveBroadSubscription<CloseError>,
  delivery: NotificationDelivery,
  logPrefix: string,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onFrame(delivery)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning(`${logPrefix} subscribeAll onFrame callback threw`, err),
    ),
  );
}

function closeSubscriber<CloseError>(
  sub: LiveSubscription<CloseError> | LiveBroadSubscription<CloseError>,
  cause: CloseError,
  logPrefix: string,
): Effect.Effect<void> {
  return Effect.suspend(() => sub.onClose(cause)).pipe(
    Effect.catchAllDefect((err) =>
      Effect.logWarning(`${logPrefix} onClose callback threw`, err),
    ),
  );
}

function subAcceptsDelivery<CloseError>(
  sub: LiveSubscription<CloseError>,
  delivery: NotificationDelivery,
  logPrefix: string,
): boolean {
  if (sub.definition !== delivery.definition) return false;
  if (sub.refinement === undefined) return true;
  return safePredicate(
    sub.refinement,
    delivery.params,
    "subscribe",
    logPrefix,
  );
}

function broadAcceptsDelivery<CloseError>(
  sub: LiveBroadSubscription<CloseError>,
  delivery: NotificationDelivery,
  logPrefix: string,
): boolean {
  if (sub.refinement === undefined) return true;
  return safePredicate(sub.refinement, delivery, "subscribeAll", logPrefix);
}

export function makeNotificationSubscriberRegistry<CloseError>(
  options: NotificationSubscriberRegistryOptions<CloseError>,
): Effect.Effect<NotificationSubscriberRegistry<CloseError>, never> {
  return Effect.gen(function* () {
    const logPrefix = options.logPrefix ?? "notification subscriber";
    const subsRef = yield* Ref.make<
      ReadonlyArray<LiveSubscription<CloseError>>
    >([]);
    const subsAllRef = yield* Ref.make<
      ReadonlyArray<LiveBroadSubscription<CloseError>>
    >([]);
    const counterRef = yield* Ref.make(0);

    const register: NotificationSubscriberRegistry<CloseError>["register"] = (
      definition,
      refinement,
      callbacks,
    ) =>
      Effect.gen(function* () {
        const id = yield* nextSubscriptionId(counterRef);
        const erasedRefinement = eraseRefinement(refinement);
        const live: LiveSubscription<CloseError> = {
          id,
          definition,
          ...(erasedRefinement !== undefined
            ? { refinement: erasedRefinement }
            : {}),
          onFrame: callbacks.onFrame as SubscriberFrameCallback,
          onClose: callbacks.onClose,
        };
        yield* Ref.update(subsRef, (subscriptions) => [
          ...subscriptions,
          live,
        ]);
        return { id, unregister: removeSubscription(subsRef, id) };
      });

    const registerAll: NotificationSubscriberRegistry<CloseError>["registerAll"] =
      (refinement, callbacks) =>
        Effect.gen(function* () {
          const id = yield* nextSubscriptionId(counterRef);
          const live: LiveBroadSubscription<CloseError> = {
            id,
            ...(refinement !== undefined ? { refinement } : {}),
            onFrame: callbacks.onFrame,
            onClose: callbacks.onClose,
          };
          yield* Ref.update(subsAllRef, (subscriptions) => [
            ...subscriptions,
            live,
          ]);
          return { id, unregister: removeSubscription(subsAllRef, id) };
        });

    const dispatch: NotificationSubscriberRegistry<CloseError>["dispatch"] = (
      delivery,
    ) =>
      Effect.gen(function* () {
        const snapshot = yield* Ref.get(subsRef);
        const broadSnapshot = yield* Ref.get(subsAllRef);
        for (const sub of snapshot) {
          if (subAcceptsDelivery(sub, delivery, logPrefix)) {
            yield* dispatchToSubscriber(sub, delivery.params, logPrefix);
          }
        }
        for (const sub of broadSnapshot) {
          if (broadAcceptsDelivery(sub, delivery, logPrefix)) {
            yield* dispatchToBroadSubscriber(sub, delivery, logPrefix);
          }
        }
      });

    const closeAll = Effect.gen(function* () {
      const snapshot = yield* Ref.getAndSet(
        subsRef,
        [] as ReadonlyArray<LiveSubscription<CloseError>>,
      );
      const broadSnapshot = yield* Ref.getAndSet(
        subsAllRef,
        [] as ReadonlyArray<LiveBroadSubscription<CloseError>>,
      );
      const cause = options.closeCause();
      for (const sub of snapshot) {
        yield* closeSubscriber(sub, cause, logPrefix);
      }
      for (const sub of broadSnapshot) {
        yield* closeSubscriber(sub, cause, logPrefix);
      }
    });

    return { register, registerAll, dispatch, closeAll };
  }).pipe(Effect.withSpan(options.spanName ?? "makeNotificationSubscriberRegistry"));
}

export function notificationSubscribe<
  CloseError,
  D extends AnyNotificationDescriptor,
  R extends NotificationParamsOf<D>,
>(
  registry: NotificationSubscriberRegistry<CloseError>,
  definition: D,
  refinement: (params: NotificationParamsOf<D>) => params is R,
): Stream.Stream<R, CloseError>;
export function notificationSubscribe<
  CloseError,
  D extends AnyNotificationDescriptor,
>(
  registry: NotificationSubscriberRegistry<CloseError>,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, CloseError>;
export function notificationSubscribe<
  CloseError,
  D extends AnyNotificationDescriptor,
>(
  registry: NotificationSubscriberRegistry<CloseError>,
  definition: D,
  refinement?: (params: NotificationParamsOf<D>) => boolean,
): Stream.Stream<NotificationParamsOf<D>, CloseError> {
  return Stream.async<NotificationParamsOf<D>, CloseError>((emit) => {
    const handle = Effect.runSync(
      registry.register(definition, refinement, {
        onFrame: (params) =>
          Effect.sync(() => {
            emit.single(params);
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

export function notificationSubscribeAll<CloseError>(
  registry: NotificationSubscriberRegistry<CloseError>,
  refinement?: (delivery: NotificationDelivery) => boolean,
): Stream.Stream<NotificationDelivery, CloseError> {
  return Stream.async<NotificationDelivery, CloseError>((emit) => {
    const handle = Effect.runSync(
      registry.registerAll(refinement, {
        onFrame: (delivery) =>
          Effect.sync(() => {
            emit.single(delivery);
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
