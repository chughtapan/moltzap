/** @file Pins the pass that consumes and publishes pending deliveries. */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type { HistoryExportRecord } from "./history-export.js";
import {
  pendingMessage,
  publishEveryPost,
  recordAcknowledgments,
} from "../__tests__/pending-delivery-fixtures.js";
import { DeliveryAcknowledgeError } from "../transport/messaging/errors.js";
import {
  makeDeliveryState,
  offerPendingMessages,
  type PendingOffer,
} from "./pass.js";

interface Observed {
  readonly acknowledged: string[];
  readonly exported: HistoryExportRecord[];
}

const first = pendingMessage(1);
const second = pendingMessage(2);
const newObserved = (): Observed => ({
  acknowledged: [],
  exported: [],
});

const consumeEveryPost: CollectiveOperations["classify"] = () =>
  Effect.succeed(Option.none());

const offerTo = (
  observed: Observed,
  classify: CollectiveOperations["classify"],
): PendingOffer => ({
  engine: recordAcknowledgments(observed.acknowledged),
  classify,
  persist: () => Effect.void,
  readAdmitted: (event) => Effect.succeed(Option.some(event)),
  historyExport: {
    record: (record) =>
      Effect.sync(() => {
        observed.exported.push(record);
      }),
  },
  state: Effect.runSync(makeDeliveryState),
});

function consumesDeliveriesWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, consumeEveryPost), [first, second]),
  );

  expect(observed.acknowledged).toEqual([
    first.deliveryToken,
    second.deliveryToken,
  ]);
}

function leavesADeliverableItemPendingWhileNoSubscriberIsAttached() {
  const observed = newObserved();

  Effect.runSync(
    offerPendingMessages(offerTo(observed, publishEveryPost), [first]),
  );

  expect(observed).toEqual({ acknowledged: [], exported: [] });
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

// @agent-code-guard/regression-only: examples pin what one pass over pending deliveries consumes, publishes and records.
describe("pending delivery pass", () => {
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
});
