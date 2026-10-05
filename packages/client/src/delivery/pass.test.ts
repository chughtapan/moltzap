/** @file Pins the pass that consumes and publishes pending deliveries. */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type { HistoryExportRecord } from "./history-export.js";
import type { HarnessMessageReadyEvent } from "./operations.js";
import {
  consumeOnly,
  pendingMessage,
  publishEveryPost,
  recordAcknowledgments,
  takeEvery,
} from "../__tests__/pending-delivery-fixtures.js";
import { DeliveryAcknowledgeError } from "../transport/messaging/errors.js";
import {
  makeDeliveryState,
  offerPendingMessages,
  type PendingOffer,
} from "./pass.js";

interface Observed {
  readonly published: HarnessMessageReadyEvent[];
  readonly acknowledged: string[];
  readonly exported: HistoryExportRecord[];
}

const first = pendingMessage(1);
const second = pendingMessage(2);
const newObserved = (): Observed => ({
  published: [],
  acknowledged: [],
  exported: [],
});

const consumeEveryPost: CollectiveOperations["classify"] = () =>
  Effect.succeed(Option.none());

const offerTo = (
  observed: Observed,
  classify: CollectiveOperations["classify"],
  subscriber: "attached" | "detached" = "attached",
): PendingOffer => ({
  engine: recordAcknowledgments(observed.acknowledged),
  classify,
  persist: () => Effect.void,
  ...(subscriber === "attached"
    ? { handler: takeEvery(observed.published) }
    : {}),
  historyExport: {
    record: (record) =>
      Effect.sync(() => {
        observed.exported.push(record);
      }),
  },
  state: Effect.runSync(makeDeliveryState),
});

function publishesEachClassifiedPostWithItsDeliveryToken() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, publishEveryPost), [first, second]),
  );

  expect(observed.published).toEqual([
    {
      deliveryToken: first.deliveryToken,
      item: { kind: "multicast", message: first.message },
    },
    {
      deliveryToken: second.deliveryToken,
      item: { kind: "multicast", message: second.message },
    },
  ]);
}

function acknowledgesAConsumedDeliveryWithoutPublishingIt() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, consumeEveryPost), [first]),
  );

  expect(observed).toMatchObject({
    published: [],
    acknowledged: [first.deliveryToken],
  });
}

function consumesDeliveriesWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, consumeEveryPost, "detached"), [
      first,
      second,
    ]),
  );

  expect(observed.acknowledged).toEqual([
    first.deliveryToken,
    second.deliveryToken,
  ]);
}

function leavesADeliverableItemPendingWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, publishEveryPost, "detached"), [
      first,
    ]),
  );

  expect(observed).toEqual({ published: [], acknowledged: [], exported: [] });
}

function goesOnToLaterDeliveriesWhenAcknowledgingAConsumedOneFails() {
  const observed = newObserved();
  const offer: PendingOffer = {
    ...offerTo(observed, consumeEveryPost),
    engine: {
      acknowledgeMessage: (deliveryToken) =>
        deliveryToken === first.deliveryToken
          ? Effect.fail(
              new DeliveryAcknowledgeError({ reason: "persistence-failed" }),
            )
          : Effect.sync(() => {
              observed.acknowledged.push(deliveryToken);
            }),
    },
  };

  Effect.runSync(offerPendingMessages(offer, [first, second]));

  expect(observed.acknowledged).toEqual([second.deliveryToken]);
}

function publishesThePostsAroundAConsumedOneAndAcknowledgesOnlyIt() {
  const observed = newObserved();
  const third = pendingMessage(3);

  Effect.runSync(
    offerPendingMessages(offerTo(observed, consumeOnly(second)), [
      first,
      second,
      third,
    ]),
  );

  expect(observed.published.map((event) => event.deliveryToken)).toEqual([
    first.deliveryToken,
    third.deliveryToken,
  ]);
  expect(observed.acknowledged).toEqual([second.deliveryToken]);
}

function classifiesEachDeliveryOnce() {
  const observed = newObserved();
  const classified: string[] = [];
  const offer = offerTo(
    observed,
    ({ message }) =>
      Effect.sync(() => {
        classified.push(message.postId);
        return Option.some({ kind: "multicast", message });
      }),
    "detached",
  );

  Effect.runSync(offerPendingMessages(offer, [first]));
  Effect.runSync(offerPendingMessages(offer, [first]));

  expect(classified).toEqual([first.message.postId]);
}

// @agent-code-guard/regression-only: examples pin what one pass over pending deliveries consumes, publishes and records.
describe("pending delivery pass", () => {
  it(
    "classifies each durable delivery once across passes",
    classifiesEachDeliveryOnce,
  );
  it(
    "publishes each classified post with its delivery token",
    publishesEachClassifiedPostWithItsDeliveryToken,
  );

  it(
    "acknowledges a consumed delivery without publishing it",
    acknowledgesAConsumedDeliveryWithoutPublishingIt,
  );

  it(
    "consumes deliveries while no subscriber is attached",
    consumesDeliveriesWhileNoSubscriberIsAttached,
  );

  it(
    "leaves a deliverable item pending while no subscriber is attached",
    leavesADeliverableItemPendingWhileNoSubscriberIsAttached,
  );

  it(
    "goes on to later deliveries when acknowledging a consumed one fails",
    goesOnToLaterDeliveriesWhenAcknowledgingAConsumedOneFails,
  );

  it(
    "publishes the posts around a consumed one and acknowledges only it",
    publishesThePostsAroundAConsumedOneAndAcknowledgesOnlyIt,
  );
});
