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
import { taskFailedNotificationDefinition } from "@moltzap/protocol/task";
import { subscribe, type subscribeAll } from "../stream.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type TaskFailedParams = NotificationParamsOf<
  typeof taskFailedNotificationDefinition
>;
type RetryableTaskFailure = TaskFailedParams & {
  readonly reason: "retryable";
};
type RetryablePredicate = (
  params: TaskFailedParams,
) => params is RetryableTaskFailure;

/**
 * Exercise the type-guard overload with concrete protocol types.
 * @param registry Notification registry supplied by a connected client.
 * @param isRetryable Predicate that narrows task failures.
 * @returns A stream narrowed to retryable task failures.
 */
export function subscribeRetryableCanary(
  registry: NotificationSubscriberRegistry<
    NotConnectedError,
    AnyNotificationDefinition
  >,
  isRetryable: RetryablePredicate,
) {
  return subscribe(registry, taskFailedNotificationDefinition, isRetryable);
}

type RetryableStream = ReturnType<typeof subscribeRetryableCanary>;

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
type RetryableOverloadResolves = Expect<
  Equal<RetryableStream, Stream.Stream<RetryableTaskFailure, NotConnectedError>>
>;
type RetryableElementIsExact = Expect<
  Equal<Stream.Stream.Success<RetryableStream>, RetryableTaskFailure>
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
  RetryableOverloadResolves,
  RetryableElementIsExact,
  SubscribeAllStreamShape,
  RunForEachHasNoLeakedRequirements,
  TypedErrorChannelIsExact,
];
