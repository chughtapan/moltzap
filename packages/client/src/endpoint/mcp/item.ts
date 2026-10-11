/** @file The daemon turns retained inbox rows into transport-sized item occurrences. */

import { Effect } from "effect";
import type { ItemEvent } from "../event-contract/index.js";
import { eventIdOf } from "../../delivery/operations.js";
import { decodeRuntimeValue, type InboxEntry } from "../../store/index.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { maximumEventBytes } from "./events/schemas.js";
import { INBOX_ITEM_EVENT } from "./names.js";

/**
 * Creates an occurrence with a stable inbox identity and complete content, or
 * a retained reference. Webhook callers persist these exact bytes before I/O;
 * poll callers recompute transport timestamps without rebinding the payload.
 * @param entry Canonical retained inbox row and its stable delivery identity.
 * @param timestamp Transport occurrence time, not a replacement item identity.
 * @returns Complete inline content or a reference to the immutable retained item.
 */
export const makeItemEvent = (entry: InboxEntry, timestamp: number) =>
  Effect.gen(function* () {
    const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
    const envelope: Omit<ItemEvent, "data"> = {
      eventId: eventIdOf(entry.deliveryToken),
      name: INBOX_ITEM_EVENT,
      timestamp: new Date(timestamp).toISOString(),
      cursor: null,
    };
    const inline: ItemEvent = { ...envelope, data: { kind: "item", item } };
    return Buffer.byteLength(JSON.stringify(inline), "utf8") <=
      maximumEventBytes
      ? inline
      : {
          ...envelope,
          data: {
            kind: "reference" as const,
            itemKind: item.kind,
            bytes: entry.canonicalItem.byteLength,
          },
        };
  }).pipe(Effect.withSpan("makeItemEvent"));
