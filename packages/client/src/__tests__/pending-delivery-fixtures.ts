/** @file Pending durable deliveries and the classify, engine and subscriber ports a delivery pass runs over. */

import { Effect, Schema } from "effect";
import type { HarnessMessageReadyEvent } from "../delivery/operations.js";
import type { PendingOffer } from "../delivery/pass.js";
import type { InboundItem } from "../transport/collectives/inbound.js";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type { EnginePendingMessage } from "../transport/messaging/index.js";
import { DeliveryToken } from "../store/index.js";
import { InboundMessage } from "../transport/messaging/message.js";
import { RecordHash } from "../transport/wire/index.js";
import { digest } from "./agent-card-fixtures.js";

/**
 * A pending durable delivery of a direct post from Bob whose delivery token,
 * record hash and PostId are all filled with `byte`, and whose text names it.
 * @param byte Value repeated across each 32-byte identifier.
 * @returns The delivery as the engine lists it.
 */
export function pendingMessage(byte: number): EnginePendingMessage {
  return {
    deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
      digest("dlv_", byte),
    ),
    recordHash: Schema.decodeUnknownSync(RecordHash)(digest("rch_", byte)),
    message: Schema.decodeUnknownSync(InboundMessage)({
      kind: "direct",
      postId: digest("pst_", byte),
      address: "agent:bob",
      sender: "agent:bob",
      content: [{ type: "text", text: `delivery ${String(byte)}` }],
    }),
  };
}

/** Classifies every post as a multicast, so the pass publishes it. */
export const publishEveryPost: CollectiveOperations["classify"] = ({
  message,
}) => Effect.succeedSome<InboundItem>({ kind: "multicast", message });

/**
 * Consumes one delivery's post, as the collective layer does an answer, and
 * classifies every other post as a multicast.
 * @param consumed The delivery whose post the layer consumes.
 * @returns The classify port.
 */
export function consumeOnly(
  consumed: EnginePendingMessage,
): CollectiveOperations["classify"] {
  return ({ message }) =>
    message.postId === consumed.message.postId
      ? Effect.succeedNone
      : Effect.succeedSome<InboundItem>({ kind: "multicast", message });
}

/**
 * An engine that acknowledges every delivery.
 * @param acknowledged Receives each acknowledged token, in order.
 * @returns The engine's acknowledgment port.
 */
export function recordAcknowledgments(
  acknowledged: string[],
): PendingOffer["engine"] {
  return {
    acknowledgeMessage: (deliveryToken) =>
      Effect.sync(() => {
        acknowledged.push(deliveryToken);
      }),
  };
}

/**
 * A subscriber that takes every event it is offered.
 * @param taken Receives each taken event, in order.
 * @returns The subscriber's publish edge.
 */
export function takeEvery(
  taken: HarnessMessageReadyEvent[],
): NonNullable<PendingOffer["handler"]> {
  return {
    publish: (event) => {
      taken.push(event);
      return true;
    },
  };
}
