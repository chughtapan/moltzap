/**
 * Type canaries for the public notification subscription signatures.
 *
 * Runtime behavior is covered by `filter-equivalence.test.ts` and
 * `snapshot-semantics.test.ts`; this file pins payload narrowing, error
 * channels, and the absence of leaked Effect requirements.
 */
import { type Effect, Stream } from "effect";
import type {
  NotConnectedError,
  NotificationDelivery,
  NotificationParamsOf,
  NotificationSubscriberRegistry,
} from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import { dispatchRelease } from "@moltzap/protocol/message/dispatch";
import { subscribe, type subscribeAll } from "../stream.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type ReleaseParams = NotificationParamsOf<typeof dispatchRelease>;
type DeniedRelease = ReleaseParams & {
  readonly verdict: { readonly decision: "deny" };
};
type DeniedPredicate = (params: ReleaseParams) => params is DeniedRelease;

/**
 * Exercise the type-guard overload with concrete protocol types.
 * @param registry Notification registry supplied by a connected client.
 * @param isDenied Predicate that narrows dispatch releases to denials.
 * @returns A stream narrowed to denied dispatch releases.
 */
export function subscribeDeniedCanary(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  isDenied: DeniedPredicate,
) {
  return subscribe(registry, dispatchRelease, isDenied);
}

type DeniedStream = ReturnType<typeof subscribeDeniedCanary>;

/**
 * Exercise Stream consumption against the real subscription return type.
 * @param stream Subscription stream to consume.
 * @param handler Handler for each decoded notification.
 * @returns The Effect produced by consuming the stream.
 */
export function runSubscriptionCanary(
  stream: ReturnType<typeof subscribe<AnyNotificationDefinition>>,
  handler: (
    notification: NotificationParamsOf<AnyNotificationDefinition>,
  ) => Effect.Effect<void>,
) {
  return Stream.runForEach(stream, handler);
}

type SubscribeStreamShape = Expect<
  Equal<
    ReturnType<typeof subscribe<AnyNotificationDefinition>>,
    Stream.Stream<
      NotificationParamsOf<AnyNotificationDefinition>,
      NotConnectedError
    >
  >
>;
type DeniedOverloadResolves = Expect<
  Equal<DeniedStream, Stream.Stream<DeniedRelease, NotConnectedError>>
>;
type DeniedElementIsExact = Expect<
  Equal<Stream.Stream.Success<DeniedStream>, DeniedRelease>
>;
type SubscribeAllStreamShape = Expect<
  Equal<
    ReturnType<typeof subscribeAll>,
    Stream.Stream<
      NotificationDelivery<AnyNotificationDefinition>,
      NotConnectedError
    >
  >
>;
type RunForEachHasNoLeakedRequirements = Expect<
  Equal<Effect.Effect.Context<ReturnType<typeof runSubscriptionCanary>>, never>
>;
type TypedErrorChannelIsExact = Expect<
  Equal<
    Stream.Stream.Error<
      ReturnType<typeof subscribe<AnyNotificationDefinition>>
    >,
    NotConnectedError
  >
>;

/** Compile-time assertions for notification subscription contracts. */
export type NotificationSubscriptionCanaries = [
  SubscribeStreamShape,
  DeniedOverloadResolves,
  DeniedElementIsExact,
  SubscribeAllStreamShape,
  RunForEachHasNoLeakedRequirements,
  TypedErrorChannelIsExact,
];
