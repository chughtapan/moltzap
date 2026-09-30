/** @file Pins the classification hook between pending reads and publication. */

import { Effect, Encoding, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { HarnessMessageReadyEvent } from "../../harness-mcp-contract.js";
import { InboundMessage } from "../../contract.js";
import { RecordHash } from "../../endpoint/representation.js";
import { DeliveryToken } from "../../endpoint/store.js";
import {
  offerPendingMessages,
  type PendingClassifier,
  type PendingOffer,
  publishOperationItems,
} from "./protocol.js";

interface Observed {
  readonly published: HarnessMessageReadyEvent[];
  readonly acknowledged: string[];
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

const offerTo = (
  observed: Observed,
  classifyPending: PendingClassifier,
): PendingOffer => ({
  engine: {
    acknowledgeMessage: (deliveryToken) =>
      Effect.sync(() => {
        observed.acknowledged.push(deliveryToken);
      }),
  },
  handler: {
    publish: (event) => observed.published.push(event) > 0,
  },
  publishedDeliveries: new Set(),
  classifyPending,
});

const consumeEveryPending: PendingClassifier = () =>
  Effect.succeed(Option.none());

// @agent-code-guard/regression-only: examples pin the two outcomes of the pending-delivery hook.
describe("pending delivery classification", () => {
  it("publishes each plain post as a multicast item with its token", () => {
    const observed: Observed = { published: [], acknowledged: [] };

    Effect.runSync(
      offerPendingMessages(offerTo(observed, publishOperationItems), [
        first,
        second,
      ]),
    );

    expect(observed).toEqual({
      published: [
        {
          deliveryToken: first.deliveryToken,
          item: { kind: "multicast", message: first.message },
        },
        {
          deliveryToken: second.deliveryToken,
          item: { kind: "multicast", message: second.message },
        },
      ],
      acknowledged: [],
    });
  });

  it("acknowledges a consumed delivery without publishing it", () => {
    const observed: Observed = { published: [], acknowledged: [] };

    Effect.runSync(
      offerPendingMessages(offerTo(observed, consumeEveryPending), [first]),
    );

    expect(observed).toEqual({
      published: [],
      acknowledged: [first.deliveryToken],
    });
  });
});
