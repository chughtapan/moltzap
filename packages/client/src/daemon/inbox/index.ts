/** @file Classified inbox paging and explicit loss of volatile request context. */

import { Effect, Encoding, Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import type {
  HarnessMessageReadyEvent,
  HarnessReadInboxRequest,
  HarnessReadInboxResult,
} from "../../harness-mcp-contract.js";
import { InboundItem, InboundMessage } from "../../contract.js";
import {
  collectiveIdOf,
  readCollectiveValue,
} from "../../endpoint/collective/wire.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
} from "../../endpoint/store.js";

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
        decodeRuntimeValue(InboundItem, entry.canonicalItem).pipe(
          Effect.map((item) => ({ deliveryToken: entry.deliveryToken, item })),
        ),
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

const lostRequest = (request: {
  readonly id: Extract<
    InboundItem,
    { readonly kind: "collectiveRequest" }
  >["id"];
  readonly to: Extract<
    InboundItem,
    { readonly kind: "collectiveRequest" }
  >["to"];
}): InboundItem => ({
  kind: "operationFailed",
  id: request.id,
  to: request.to,
  error:
    "Collective request context was lost when the endpoint restarted. Its response outcome is unknown; this request cannot be answered again.",
});

/**
 * Raw requests can outlive a crash before projection or a schema upgrade.
 * @param store Daemon-owned persistence read before normal classification.
 * @returns Completion after lost requests are replaced atomically.
 */
const retireUnprojectedRequests = (store: EndpointStore) =>
  Effect.gen(function* () {
    const pending = yield* store.readPendingDeliveries();
    for (const entry of pending) {
      const message = yield* decodeRuntimeValue(
        InboundMessage,
        entry.canonicalMessage,
      );
      const collective = yield* readCollectiveValue(message.content).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none())),
      );
      if (
        Option.isNone(collective) ||
        collective.value.kind !== "operation" ||
        collective.value.op === "multicast"
      ) {
        continue;
      }
      const value = collective.value;
      if (collectiveIdOf(message.sender, value.nonce) === value.id) {
        yield* store.replaceInboxItem(entry.deliveryToken, {
          deliveryToken: yield* mintLocalDeliveryToken,
          canonicalItem: yield* encodeRuntimeValue(
            lostRequest({
              id: value.id,
              to: value.op === "gather" ? message.sender : message.address,
            }),
          ),
        });
      }
    }
  });

/**
 * Retire requests whose schema, address and answered state were process-local.
 * Results and failures retain their original delivery identity across restart.
 * @param store Daemon-owned endpoint persistence.
 * @returns Completion after each lost request has a separately identified failure.
 */
export const recoverRuntimeInbox = (
  store: EndpointStore,
): Effect.Effect<void, EndpointStoreError> =>
  Effect.gen(function* () {
    let page = yield* store.readInbox();
    while (true) {
      for (const entry of page.items) {
        const item = yield* decodeRuntimeValue(
          InboundItem,
          entry.canonicalItem,
        );
        if (item.kind !== "collectiveRequest") {
          continue;
        }
        const failure = lostRequest(item);
        const canonicalItem = yield* encodeRuntimeValue(failure);
        const deliveryToken = yield* mintLocalDeliveryToken;
        yield* store.replaceInboxItem(entry.deliveryToken, {
          deliveryToken,
          canonicalItem,
        });
        yield* Effect.logWarning(
          `collective request context lost at restart: ${item.id}`,
        );
      }
      if (page.nextAfter === undefined) {
        yield* retireUnprojectedRequests(store);
        return;
      }
      page = yield* store.readInbox({
        after: page.nextAfter,
        through: page.through,
      });
    }
  }).pipe(Effect.withSpan("recoverRuntimeInbox"));
