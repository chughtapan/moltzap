/**
 * @file Pins the public notification subscription signatures as type-level
 * canaries for payload narrowing, failures, and Effect requirements.
 *
 * Runtime behavior is covered by `filter-equivalence.test.ts` and
 * `snapshot-semantics.test.ts`.
 */
import type {
  NotConnectedError,
  NotificationDelivery,
  NotificationParamsOf,
  NotificationSubscriberRegistry,
} from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { type Effect, Stream } from "effect";
import { subscribe, type subscribeAll } from "../stream.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type ReceivedParams = NotificationParamsOf<
  typeof messageReceivedNotificationDefinition
>;
type GroupReceived = ReceivedParams & {
  readonly message: { readonly conversationId: string };
};
type GroupPredicate = (params: ReceivedParams) => params is GroupReceived;

/**
 * Exercise the type-guard overload with concrete protocol types.
 * @param registry Notification registry supplied by a connected client.
 * @param isGroup Predicate that narrows received messages to group deliveries.
 * @returns A stream narrowed to group message deliveries.
 */
export function subscribeNarrowedCanary(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  isGroup: GroupPredicate,
) {
  return subscribe(registry, messageReceivedNotificationDefinition, isGroup);
}

type NarrowedStream = ReturnType<typeof subscribeNarrowedCanary>;

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
type NarrowedOverloadResolves = Expect<
  Equal<NarrowedStream, Stream.Stream<GroupReceived, NotConnectedError>>
>;
type NarrowedElementIsExact = Expect<
  Equal<Stream.Stream.Success<NarrowedStream>, GroupReceived>
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
  NarrowedOverloadResolves,
  NarrowedElementIsExact,
  SubscribeAllStreamShape,
  RunForEachHasNoLeakedRequirements,
  TypedErrorChannelIsExact,
];
