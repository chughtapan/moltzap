/**
 * @file One pass over pending deliveries: the collective layer classifies
 * each durable delivery, consumed ones are acknowledged, and the remaining
 * items and the layer's own are published in order while a subscriber takes
 * them.
 */

import { DateTime, Effect, Option } from "effect";
import type { DeliveryToken } from "../store/index.js";
import type { InboundItem } from "../transport/collectives/inbound.js";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type {
  EndpointEngine,
  EnginePendingMessage,
} from "../transport/messaging/index.js";
import type { HistoryExportPort } from "./history-export.js";
import type { HarnessMessageReadyEvent } from "./operations.js";

/** The subscriber's publish edge; false means it refused the event. */
interface Subscriber {
  readonly publish: (event: HarnessMessageReadyEvent) => boolean;
}

/** What one pass over pending deliveries reads and changes. */
export interface PendingOffer {
  readonly engine: Pick<EndpointEngine, "acknowledgeMessage">;
  readonly classify: CollectiveOperations["classify"];
  /** Classified items are durable even while no host is attached. */
  readonly persist: (event: HarnessMessageReadyEvent) => Effect.Effect<void>;
  /** The attached subscriber, absent while none is attached. */
  readonly handler?: Subscriber;
  readonly historyExport: HistoryExportPort;
  readonly publishedDeliveries: Set<string>;
  readonly exportedDeliveries: Set<string>;
  /**
   * The item each unacknowledged durable delivery classified into, so a
   * delivery is decoded and classified once rather than on every pass.
   */
  readonly classifiedItems: Map<string, InboundItem>;
}

/**
 * Acknowledge a delivery the collective layer consumed. A failed
 * acknowledgment is logged and the delivery stays pending: the next pass
 * classifies it again, which records nothing twice because the requester
 * and every all_gather member keep only a member's first answer and a member
 * applies a close once, and acknowledges it again. It does
 * not end the daemon, whose store failures surface through the pending read
 * that starts every pass.
 */
const acknowledgeConsumed = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<void> =>
  offer.engine
    .acknowledgeMessage(pending.deliveryToken)
    .pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`consumed delivery stays pending: ${error.message}`),
      ),
    );

/**
 * Record an item in the history export the first time it is offered, then
 * offer it to the subscriber, yielding whether the subscriber took it. The
 * line lands before the item is visible, for the reason `makeHistoryExport`
 * gives.
 *
 * The append runs inside the pass, under the delivery gate. It cannot
 * deadlock: the export's own gate is taken only inside `record`, which takes
 * no other lock, and a send records its outbound line without the delivery
 * gate. Its cost is one append per item on first offer, only when an operator
 * configured the export, and an acknowledgment waits for the pass that holds
 * the gate.
 */
const publishItem = (
  offer: PendingOffer,
  handler: Subscriber,
  event: HarnessMessageReadyEvent,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!offer.exportedDeliveries.has(event.deliveryToken)) {
      const at = yield* DateTime.now;
      yield* offer.historyExport.record({
        kind: "inbound",
        item: event.item,
        at,
      });
      offer.exportedDeliveries.add(event.deliveryToken);
    }
    if (!handler.publish(event)) {
      return false;
    }
    offer.publishedDeliveries.add(event.deliveryToken);
    return true;
  });

const classifyOnce = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<Option.Option<HarnessMessageReadyEvent>> =>
  offer.classify(pending).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          acknowledgeConsumed(offer, pending).pipe(Effect.as(Option.none())),
        onSome: (item) =>
          offer.persist({ deliveryToken: pending.deliveryToken, item }).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                offer.classifiedItems.set(pending.deliveryToken, item);
                return Option.some({
                  deliveryToken: pending.deliveryToken,
                  item,
                });
              }),
            ),
          ),
      }),
    ),
  );

/**
 * Classify one durable delivery not yet published: acknowledge it when the
 * collective layer consumes it, otherwise return its event, reusing the item
 * an earlier pass classified.
 */
const classifyPending = (
  offer: PendingOffer,
  pending: EnginePendingMessage,
): Effect.Effect<Option.Option<HarnessMessageReadyEvent>> => {
  const { deliveryToken } = pending;
  if (offer.publishedDeliveries.has(deliveryToken)) {
    return Effect.succeed(Option.none());
  }
  const classified = offer.classifiedItems.get(deliveryToken);
  return classified === undefined
    ? classifyOnce(offer, pending)
    : Effect.succeed(Option.some({ deliveryToken, item: classified }));
};

/** Publish events in order, skipping published ones, until one is refused. */
const publishInOrder = (
  offer: PendingOffer,
  handler: Subscriber,
  events: readonly HarnessMessageReadyEvent[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const event of events) {
      if (offer.publishedDeliveries.has(event.deliveryToken)) {
        continue;
      }
      if (!(yield* publishItem(offer, handler, event))) {
        return;
      }
    }
  });

/**
 * Offer pending deliveries in order, then the collective layer's own items.
 * Every durable delivery is classified: the layer consumes protocol posts,
 * which are acknowledged here whether or not a subscriber is attached, so
 * answers are recorded and deadlines complete with nobody listening. Items
 * are published while a subscriber accepts them; after the first refusal,
 * or with no subscriber, they stay pending for a later pass.
 * @param offer The engine, classifier, subscriber and delivery bookkeeping.
 * @param messages Pending durable deliveries in order.
 * @param localItems Items the collective layer emitted, in order.
 * @returns Completion after every delivery is consumed or offered.
 */
export const offerPendingMessages = (
  offer: PendingOffer,
  messages: readonly EnginePendingMessage[],
  localItems: ReadonlyMap<DeliveryToken, InboundItem>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const classified = yield* Effect.forEach(
      messages,
      (pending) => classifyPending(offer, pending),
      { concurrency: 1 },
    );
    const handler = offer.handler;
    if (handler === undefined) {
      return;
    }
    yield* publishInOrder(offer, handler, [
      ...classified.flatMap((event) => Option.toArray(event)),
      ...[...localItems].map(([deliveryToken, item]) => ({
        deliveryToken,
        item,
      })),
    ]);
  }).pipe(Effect.withSpan("offerPendingMessages"));
