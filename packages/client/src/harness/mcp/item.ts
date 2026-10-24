/** @file Classified inbox events shared by native delivery transports. */

import { Effect } from "effect";
import { InboundItem } from "../../communication/collectives/inbound.js";
import {
  decodeRuntimeValue,
  type InboxEntry,
} from "../../communication/store/index.js";
import { localGuidanceSchema } from "../../firewall/outcome/index.js";
import { maximumEventBytes } from "../protocol/index.js";
import { INBOX_ITEM_EVENT } from "../protocol/names.js";
import { eventIdOf } from "../protocol/operations.js";

/**
 * Keeps the original item and separate local guidance together. An envelope
 * exceeding the transport bound carries a reference to the retained event;
 * neither content nor guidance is truncated.
 * @param entry The admitted, immutable inbox row.
 * @param timestamp The occurrence's Unix time in milliseconds.
 * @returns A bounded event whose identity remains stable across retries.
 */
export const makeItemEvent = Effect.fn("makeItemEvent")(function* (
  entry: InboxEntry,
  timestamp: number,
) {
  const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
  const guidance =
    entry.canonicalGuidance === undefined
      ? undefined
      : yield* decodeRuntimeValue(localGuidanceSchema, entry.canonicalGuidance);
  const envelope = {
    eventId: eventIdOf(entry.deliveryToken),
    name: INBOX_ITEM_EVENT,
    timestamp: new Date(timestamp).toISOString(),
    cursor: null,
  } as const;
  const event = {
    ...envelope,
    data: {
      kind: "item" as const,
      item,
      ...(guidance === undefined ? {} : { guidance }),
    },
  };
  return Buffer.byteLength(JSON.stringify(event), "utf8") <= maximumEventBytes
    ? event
    : {
        ...envelope,
        data: {
          kind: "reference" as const,
          itemKind: item.kind,
          bytes:
            entry.canonicalItem.byteLength +
            (entry.canonicalGuidance?.byteLength ?? 0),
        },
      };
});
