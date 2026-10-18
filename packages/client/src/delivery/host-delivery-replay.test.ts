/** @file Current-store replay retains local guidance independently of new policy checks. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { expect } from "vitest";
import { localGuidance } from "../__tests__/message-policy-fixtures.js";
import {
  pendingMessage,
  publishEveryPost,
  recordAcknowledgments,
  takeEvery,
} from "../__tests__/pending-delivery-fixtures.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { encodeRuntimeValue, openEndpointStore } from "../store/index.js";
import { noHistoryExport } from "./history-export.js";
import { makeHostDelivery } from "./host-delivery.js";
import { eventIdOf, type HarnessMessageReadyEvent } from "./operations.js";

const pending = pendingMessage(1);
const retained: HarnessMessageReadyEvent = {
  deliveryToken: pending.deliveryToken,
  item: { kind: "multicast", message: pending.message },
  guidance: localGuidance(1),
};

const reopenedDelivery = Effect.gen(function* () {
  const path = stateDirectory();
  yield* Effect.scoped(
    Effect.gen(function* () {
      const store = yield* openEndpointStore(path);
      yield* store.putInboxItem({
        deliveryToken: retained.deliveryToken,
        canonicalItem: yield* encodeRuntimeValue(retained.item),
        canonicalGuidance: yield* encodeRuntimeValue(retained.guidance),
      });
    }),
  );
  const store = yield* openEndpointStore(path);
  const published: HarnessMessageReadyEvent[] = [];
  const delivery = yield* makeHostDelivery({
    store,
    historyExport: noHistoryExport,
    collectives: () => ({ send: () => Effect.dieMessage("unexpected send") }),
    scope: yield* Scope.Scope,
  });
  return {
    delivery,
    published,
    pass: {
      readPending: Effect.succeed([pending]),
      engine: recordAcknowledgments([]),
      classify: publishEveryPost,
      handler: takeEvery(published),
    },
  };
});

it("replays the admitted envelope after restarting without a firewall", () =>
  Effect.gen(function* () {
    const { delivery, published, pass } = yield* reopenedDelivery;
    yield* delivery.runPass(() => pass);
    expect(published).toEqual([retained]);
    expect(yield* delivery.operations.readInbox({})).toEqual({
      items: [retained],
    });
    yield* delivery.operations.acknowledgeDelivery(retained.deliveryToken);
    yield* delivery.detach;
    yield* delivery.runPass(() => pass);
    expect(published).toEqual([retained]);
    expect(yield* delivery.operations.readInbox({})).toEqual({ items: [] });
    expect(
      yield* delivery.operations.readEvent({
        eventId: eventIdOf(retained.deliveryToken),
      }),
    ).toEqual({ item: retained.item, guidance: retained.guidance });
  }));

it("rejects changed content under a retained guidance-bearing token", () =>
  Effect.gen(function* () {
    const { delivery, published, pass } = yield* reopenedDelivery;
    const changed = { ...pending, message: pendingMessage(2).message };
    const refusal = yield* Effect.flip(
      delivery.runPass(() => ({
        ...pass,
        readPending: Effect.succeed([changed]),
      })),
    );
    expect(refusal).toMatchObject({
      _tag: "EndpointStoreError",
      reason: "conflict",
    });
    expect(published).toEqual([]);
    expect(yield* delivery.operations.readInbox({})).toEqual({
      items: [retained],
    });
  }));
