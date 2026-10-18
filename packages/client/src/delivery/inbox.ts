/** @file Classified inbox paging and explicit loss of volatile request context. */

import { Effect, Encoding, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { localGuidanceSchema } from "../firewall/runtime.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
  type InboxEntry,
} from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import {
  eventIdSchema,
  type HarnessMessageReadyEvent,
  type HarnessReadInboxRequest,
  type HarnessReadInboxResult,
} from "./operations.js";

/**
 * Invalid aliases cannot address the same retained item under another event id.
 * @param store Retained immutable classified inbox.
 * @param eventId Canonical event identity carried by a webhook.
 * @returns The original item or a closed lookup failure.
 */
export const readRuntimeEvent = (
  store: Pick<EndpointStore, "readInboxItem">,
  eventId: string,
) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknown(eventIdSchema)(eventId);
    const token = yield* Schema.decodeUnknown(DeliveryToken)(
      `dlv_${eventId.slice(4)}`,
    );
    const retained = yield* store.readInboxItem(token);
    if (retained === undefined) {
      return yield* Effect.fail({ reason: "unknown-event" });
    }
    return {
      item: yield* decodeRuntimeValue(InboundItem, retained.canonicalItem),
      ...(retained.canonicalGuidance === undefined
        ? {}
        : {
            guidance: yield* decodeRuntimeValue(
              localGuidanceSchema,
              retained.canonicalGuidance,
            ),
          }),
    };
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail({ reason: "invalid-event" }),
    ),
    Effect.withSpan("readRuntimeEvent"),
  );

const cursorSchema = Schema.Struct({
  after: Schema.NonNegativeInt,
  through: Schema.NonNegativeInt,
}).annotations({ parseOptions: { exact: true, onExcessProperty: "error" } });

/**
 * Persist a classified item before any host can observe its delivery identity.
 * @param store Daemon-owned endpoint persistence.
 * @param event Stable delivery identity and classified payload.
 * @returns Completion once the immutable token binding is durable.
 */
export const persistInboxItem = (
  store: EndpointStore,
  event: HarnessMessageReadyEvent,
): Effect.Effect<void, EndpointStoreError> =>
  encodeRuntimeValue(event.item).pipe(
    Effect.flatMap((canonicalItem) =>
      store.putInboxItem({ deliveryToken: event.deliveryToken, canonicalItem }),
    ),
    Effect.asVoid,
  );

const decodeCursor = (
  cursor?: string,
): Effect.Effect<
  { readonly after?: number; readonly through?: number },
  EndpointStoreError
> =>
  cursor === undefined
    ? Effect.succeed({})
    : Effect.suspend(() => Encoding.decodeBase64Url(cursor)).pipe(
        Effect.flatMap((bytes) => decodeRuntimeValue(cursorSchema, bytes)),
        Effect.catchTags({
          DecodeException: () =>
            Effect.fail(
              new EndpointStoreError({ reason: "invalid-continuation" }),
            ),
          EndpointStoreError: () =>
            Effect.fail(
              new EndpointStoreError({ reason: "invalid-continuation" }),
            ),
        }),
      );

/**
 * Read the classified projection, never the underlying collective protocol posts.
 * @param store Daemon-owned endpoint persistence.
 * @param input Optional position within an earlier bounded snapshot.
 * @returns An inbox page and the continuation within that same snapshot.
 */
export const readRuntimeInbox = (
  store: EndpointStore,
  input: HarnessReadInboxRequest,
): Effect.Effect<HarnessReadInboxResult, EndpointStoreError> =>
  Effect.gen(function* () {
    const page = yield* decodeCursor(input.cursor).pipe(
      Effect.flatMap((bounds) => store.readInbox(bounds)),
    );
    const items = yield* Effect.forEach(
      page.items,
      (entry) =>
        Effect.gen(function* () {
          return {
            deliveryToken: entry.deliveryToken,
            item: yield* decodeRuntimeValue(InboundItem, entry.canonicalItem),
            ...(entry.canonicalGuidance === undefined
              ? {}
              : {
                  guidance: yield* decodeRuntimeValue(
                    localGuidanceSchema,
                    entry.canonicalGuidance,
                  ),
                }),
          };
        }),
      { concurrency: 1 },
    );
    if (page.nextAfter === undefined) {
      return { items };
    }
    const cursor = yield* encodeRuntimeValue({
      after: page.nextAfter,
      through: page.through,
    });
    return { items, nextCursor: Encoding.encodeBase64Url(cursor) };
  }).pipe(Effect.withSpan("readRuntimeInbox"));

/** A delivery token for a durable item emitted locally, without a Router post. */
export const mintLocalDeliveryToken = Effect.sync(() =>
  Schema.decodeUnknownSync(DeliveryToken)(
    `dlv_${randomBytes(32).toString("base64url")}`,
  ),
);

const lostRequest = (
  request: Pick<
    Extract<InboundItem, { readonly kind: "collectiveRequest" }>,
    "id" | "from" | "to"
  >,
): InboundItem => ({
  kind: "operationFailed",
  id: request.id,
  to: request.to,
  error: `reply failed: MoltZap restarted, so the question from ${request.from} can no longer be answered; an answer already sent may or may not have arrived`,
});

const recoverRequest = Effect.fn("recoverRequest")(function* (
  store: EndpointStore,
  entry: InboxEntry,
  withFirewall: boolean,
) {
  const item = yield* decodeRuntimeValue(InboundItem, entry.canonicalItem);
  if (item.kind !== "collectiveRequest") {
    return;
  }
  yield* store.replaceInboxItem(
    entry.deliveryToken,
    {
      deliveryToken: yield* mintLocalDeliveryToken,
      canonicalItem: yield* encodeRuntimeValue(lostRequest(item)),
    },
    withFirewall ? item.to : undefined,
  );
  yield* Effect.logWarning(
    `collective request context lost at restart: ${item.id}`,
  );
});

/**
 * Retire requests whose schema, address and answered state were process-local.
 * Results and failures retain their original delivery identity across restart.
 * @param store Daemon-owned endpoint persistence.
 * @param withFirewall Whether replacements require private admission before visibility.
 * @returns Completion after each lost request has a separately identified failure.
 */
export const recoverRuntimeInbox = (
  store: EndpointStore,
  withFirewall = false,
): Effect.Effect<void, EndpointStoreError> =>
  Effect.gen(function* () {
    if (withFirewall) {
      yield* recoverPrivateRequests(store);
    }
    let page = yield* store.readInbox();
    while (true) {
      for (const entry of page.items) {
        yield* recoverRequest(store, entry, withFirewall);
      }
      if (page.nextAfter === undefined) {
        return;
      }
      page = yield* store.readInbox({
        after: page.nextAfter,
        through: page.through,
      });
    }
  }).pipe(Effect.withSpan("recoverRuntimeInbox"));

function recoverPrivateRequests(store: EndpointStore) {
  return Effect.gen(function* () {
    let after = 0;
    while (true) {
      const entries = yield* store.readPendingFirewallItems(after);
      for (const entry of entries) {
        yield* recoverRequest(store, entry, true);
      }
      const last = entries.at(-1);
      if (last === undefined) {
        return;
      }
      after = last.sequence;
    }
  });
}
