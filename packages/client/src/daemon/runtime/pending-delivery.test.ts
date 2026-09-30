/** @file Pins the pass that consumes and publishes pending deliveries. */

import { Effect, Encoding, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveOperations } from "../../endpoint/collective/operation.js";
import type { HarnessMessageReadyEvent } from "../../harness-mcp-contract.js";
import {
  DeliveryAcknowledgeError,
  type HistoryExportRecord,
  InboundItem,
  InboundMessage,
} from "../../contract.js";
import { RecordHash } from "../../endpoint/representation.js";
import { DeliveryToken } from "../../endpoint/store.js";
import { offerPendingMessages, type PendingOffer } from "./pending-delivery.js";

interface Observed {
  readonly published: HarnessMessageReadyEvent[];
  readonly acknowledged: string[];
  readonly exported: HistoryExportRecord[];
}

const digest = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;

const pendingMessage = (byte: number) => ({
  deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", byte)),
  recordHash: Schema.decodeUnknownSync(RecordHash)(digest("rch_", byte)),
  message: Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: digest("pst_", byte),
    address: "agent:bob",
    sender: "agent:bob",
    content: [{ type: "text", text: `delivery ${String(byte)}` }],
  }),
});

const first = pendingMessage(1);
const second = pendingMessage(2);
const localToken = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 9));
const localItem = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: digest("col_", 9),
  to: "agent:bob",
  error: "collective failed",
});
const noLocalItems = new Map<DeliveryToken, InboundItem>();

const newObserved = (): Observed => ({
  published: [],
  acknowledged: [],
  exported: [],
});

const publishEveryPost: CollectiveOperations["classify"] = (message) =>
  Effect.succeed(Option.some({ kind: "multicast", message }));

const consumeEveryPost: CollectiveOperations["classify"] = () =>
  Effect.succeed(Option.none());

/** Consumes the second pending post, as the collective layer does an answer. */
const consumeSecond: CollectiveOperations["classify"] = (message) =>
  Effect.succeed(
    message.postId === second.message.postId
      ? Option.none()
      : Option.some({ kind: "multicast", message }),
  );

const offerTo = (
  observed: Observed,
  classify: CollectiveOperations["classify"],
  subscriber: "attached" | "detached" = "attached",
): PendingOffer => ({
  engine: {
    acknowledgeMessage: (deliveryToken) =>
      Effect.sync(() => {
        observed.acknowledged.push(deliveryToken);
      }),
  },
  classify,
  ...(subscriber === "attached"
    ? { handler: { publish: (event) => observed.published.push(event) > 0 } }
    : {}),
  historyExport: {
    record: (record) =>
      Effect.sync(() => {
        observed.exported.push(record);
      }),
  },
  publishedDeliveries: new Set(),
  exportedDeliveries: new Set(),
  classifiedItems: new Map(),
});

function publishesEachClassifiedPostWithItsDeliveryToken() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(
      offerTo(observed, publishEveryPost),
      [first, second],
      noLocalItems,
    ),
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
    offerPendingMessages(
      offerTo(observed, consumeEveryPost),
      [first],
      noLocalItems,
    ),
  );

  expect(observed).toMatchObject({
    published: [],
    acknowledged: [first.deliveryToken],
  });
}

function consumesDeliveriesWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(
      offerTo(observed, consumeEveryPost, "detached"),
      [first, second],
      noLocalItems,
    ),
  );

  expect(observed.acknowledged).toEqual([
    first.deliveryToken,
    second.deliveryToken,
  ]);
}

function leavesADeliverableItemPendingWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(
      offerTo(observed, publishEveryPost, "detached"),
      [first],
      noLocalItems,
    ),
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

  Effect.runSync(offerPendingMessages(offer, [first, second], noLocalItems));

  expect(observed.acknowledged).toEqual([second.deliveryToken]);
}

function stopsPublishingAtARefusalButStillConsumesLaterDeliveries() {
  const observed = newObserved();
  const third = pendingMessage(3);
  const offer: PendingOffer = {
    ...offerTo(observed, consumeSecond),
    handler: { publish: () => false },
  };

  Effect.runSync(
    offerPendingMessages(offer, [first, second, third], noLocalItems),
  );

  expect(observed.acknowledged).toEqual([second.deliveryToken]);
  expect(offer.publishedDeliveries.size).toBe(0);
}

function publishesThePostsAroundAConsumedOneAndAcknowledgesOnlyIt() {
  const observed = newObserved();
  const third = pendingMessage(3);

  Effect.runSync(
    offerPendingMessages(
      offerTo(observed, consumeSecond),
      [first, second, third],
      noLocalItems,
    ),
  );

  expect(observed.published.map((event) => event.deliveryToken)).toEqual([
    first.deliveryToken,
    third.deliveryToken,
  ]);
  expect(observed.acknowledged).toEqual([second.deliveryToken]);
}

function publishesTheCollectiveLayerSOwnItemsAfterDurableDeliveries() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(
      offerTo(observed, publishEveryPost),
      [first],
      new Map([[localToken, localItem]]),
    ),
  );

  expect(observed.published.map((event) => event.deliveryToken)).toEqual([
    first.deliveryToken,
    localToken,
  ]);
}

function recordsEachPublishedItemInTheHistoryExportOnce() {
  const observed = newObserved();
  const offer = offerTo(observed, publishEveryPost);

  Effect.runSync(offerPendingMessages(offer, [first], noLocalItems));
  offer.publishedDeliveries.clear();
  Effect.runSync(offerPendingMessages(offer, [first], noLocalItems));

  expect(observed.exported).toMatchObject([
    {
      kind: "inbound",
      item: { kind: "multicast", message: first.message },
    },
  ]);
}

function classifiesEachDeliveryOnce() {
  const observed = newObserved();
  const classified: string[] = [];
  const offer = offerTo(
    observed,
    (message) =>
      Effect.sync(() => {
        classified.push(message.postId);
        return Option.some({ kind: "multicast", message });
      }),
    "detached",
  );

  Effect.runSync(offerPendingMessages(offer, [first], noLocalItems));
  Effect.runSync(offerPendingMessages(offer, [first], noLocalItems));

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
    "stops publishing at a refusal but still consumes later deliveries",
    stopsPublishingAtARefusalButStillConsumesLaterDeliveries,
  );

  it(
    "publishes the posts around a consumed one and acknowledges only it",
    publishesThePostsAroundAConsumedOneAndAcknowledgesOnlyIt,
  );

  it(
    "publishes the collective layer's own items after durable deliveries",
    publishesTheCollectiveLayerSOwnItemsAfterDurableDeliveries,
  );

  it(
    "records each published item in the history export once",
    recordsEachPublishedItemInTheHistoryExportOnce,
  );
});
