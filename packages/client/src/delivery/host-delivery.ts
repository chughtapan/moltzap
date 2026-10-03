/** @file One service's delivery: its state, the inbox writes the delivery pass makes, and the operations hosts call. */

import { DateTime, Effect, type Scope } from "effect";
import type { SendInput } from "../transport/collectives/forms.js";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type {
  HistoryExportPort,
  HistoryExportRecord,
} from "./history-export.js";
import type {
  DeliveryOperations,
  EventStore,
  HarnessMessageReadyEvent,
  HarnessReadInboxRequest,
} from "./operations.js";
import {
  decodeRuntimeValue,
  type DeliveryToken,
  type EndpointStore,
  type EndpointStoreError,
} from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import {
  DeliveryAcknowledgeError,
  SendError,
} from "../transport/messaging/errors.js";
import {
  mintLocalDeliveryToken,
  persistInboxItem,
  readRuntimeEvent,
  readRuntimeInbox,
  recoverRuntimeInbox,
} from "./inbox.js";
import { makeSendInvocations } from "./send-invocations.js";
import {
  type DeliveryState,
  forgetDelivery,
  makeDeliveryState,
} from "./state.js";

/** What one service's delivery reads and writes. */
export interface HostDeliveryInput {
  readonly store: EndpointStore;
  readonly historyExport: HistoryExportPort;
  /** The active collective layer, absent while the service is unregistered. */
  readonly collectives: () => Pick<CollectiveOperations, "send"> | undefined;
  /** Service lifetime, independent of any host request. */
  readonly scope: Scope.Scope;
}

/** One service's delivery, created once and shared by the delivery pass and every host operation. */
export interface HostDelivery {
  readonly state: DeliveryState;
  readonly operations: DeliveryOperations;
  readonly eventStore: EventStore;
  /** Make a classified item durable before any host can observe its token. */
  readonly persist: (
    event: HarnessMessageReadyEvent,
  ) => Effect.Effect<void, EndpointStoreError>;
  /** Make an item the collective layer emitted durable and queue it for the next pass. */
  readonly queueLocalItem: (
    item: InboundItem,
  ) => Effect.Effect<void, EndpointStoreError>;
}

type DeliveryContext = HostDeliveryInput & { readonly state: DeliveryState };

const notRegistered = Effect.fail({ reason: "not-registered" });

/**
 * Record one completed `send` in the history export with its input and how it
 * ended: the posts certified by its return, or the error it returned.
 */
const exportSend = (
  historyExport: HistoryExportPort,
  input: SendInput,
  outcome: Extract<
    HistoryExportRecord,
    { readonly kind: "outbound" }
  >["outcome"],
): Effect.Effect<void> =>
  DateTime.now.pipe(
    Effect.flatMap((at) =>
      historyExport.record({ kind: "outbound", input, outcome, at }),
    ),
  );

const sendOperation =
  (input: DeliveryContext): DeliveryOperations["send"] =>
  (request) =>
    Effect.suspend(() => {
      const collectives = input.collectives();
      if (collectives === undefined) {
        return Effect.fail(new SendError({ reason: "not-registered" }));
      }
      return collectives
        .send(request.input, request.failureDelivery ?? "result")
        .pipe(
          Effect.tapBoth({
            onFailure: (error) =>
              exportSend(input.historyExport, request.input, {
                kind: "failed",
                error: error.message,
              }),
            onSuccess: (outcome) =>
              exportSend(input.historyExport, request.input, {
                kind: "sent",
                ...outcome,
              }),
          }),
          Effect.map(({ operationId }) =>
            operationId === undefined ? {} : { operationId },
          ),
        );
    });

/** Retire the durable inbox binding before dropping its process-local caches. */
const acknowledgeDelivery =
  (input: DeliveryContext): DeliveryOperations["acknowledgeDelivery"] =>
  (deliveryToken) =>
    input.state.gate.withPermits(1)(
      Effect.suspend(() =>
        input.collectives() === undefined
          ? Effect.fail(
              new DeliveryAcknowledgeError({ reason: "unknown-delivery" }),
            )
          : input.store.acknowledgeInboxItem(deliveryToken).pipe(
              Effect.catchTag("EndpointStoreError", (error) =>
                Effect.fail(
                  new DeliveryAcknowledgeError({
                    reason:
                      error.reason === "not-found"
                        ? "unknown-delivery"
                        : "persistence-failed",
                  }),
                ),
              ),
              Effect.tap(() => forgetDelivery(input.state, deliveryToken)),
            ),
      ),
    );

/** Export replayed local items before a host can read them after restart. */
const readAndExportInbox = (
  input: DeliveryContext,
  request: HarnessReadInboxRequest,
) =>
  input.state.gate.withPermits(1)(
    Effect.gen(function* () {
      const page = yield* readRuntimeInbox(input.store, request);
      for (const entry of page.items) {
        if (!input.state.exportedDeliveries.has(entry.deliveryToken)) {
          const at = yield* DateTime.now;
          yield* input.historyExport.record({
            kind: "inbound",
            item: entry.item,
            at,
          });
          input.state.exportedDeliveries.add(entry.deliveryToken);
        }
      }
      return page;
    }),
  );

/** Webhook reads share export ordering with native inbox reads. */
const readWebhookInbox = (
  input: DeliveryContext,
  bounds: Parameters<EndpointStore["readInbox"]>[0],
) =>
  input.state.gate.withPermits(1)(
    Effect.gen(function* () {
      const page = yield* input.store.readInbox(bounds);
      for (const entry of page.items) {
        if (!input.state.exportedDeliveries.has(entry.deliveryToken)) {
          const item = yield* decodeRuntimeValue(
            InboundItem,
            entry.canonicalItem,
          );
          const at = yield* DateTime.now;
          yield* input.historyExport.record({ kind: "inbound", item, at });
          input.state.exportedDeliveries.add(entry.deliveryToken);
        }
      }
      return page;
    }),
  );

/** Waiters can stop during shutdown; an acquired receipt commits with its caller state intact. */
const completeWebhookDelivery = (
  input: DeliveryContext,
  token: DeliveryToken,
  bytes: Uint8Array,
) =>
  Effect.uninterruptibleMask(() =>
    input.state.gate.take(1).pipe(
      Effect.interruptible,
      Effect.flatMap((permits) =>
        input.store.completeWebhookDelivery(token, bytes).pipe(
          Effect.tap(() => forgetDelivery(input.state, token)),
          Effect.ensuring(input.state.gate.release(permits)),
        ),
      ),
    ),
  );

const queueLocalItem =
  (input: DeliveryContext): HostDelivery["queueLocalItem"] =>
  (item) =>
    mintLocalDeliveryToken.pipe(
      Effect.tap((deliveryToken) =>
        persistInboxItem(input.store, { deliveryToken, item }),
      ),
      Effect.tap((deliveryToken) =>
        Effect.sync(() => {
          input.state.localItems.set(deliveryToken, item);
        }),
      ),
      Effect.asVoid,
    );

/**
 * Recover the inbox left by the previous process, then build the service's
 * delivery over it.
 * @param service The store, history export, active collective layer and service scope.
 * @returns The delivery state, the host operations and the webhook's inbox view.
 */
export const makeHostDelivery = (
  service: HostDeliveryInput,
): Effect.Effect<HostDelivery, EndpointStoreError> =>
  Effect.gen(function* () {
    const input: DeliveryContext = {
      ...service,
      state: yield* makeDeliveryState,
    };
    yield* recoverRuntimeInbox(input.store);
    const invocations = yield* makeSendInvocations(
      input.store,
      sendOperation(input),
      input.scope,
    );
    const eventStore: EventStore = {
      ...input.store,
      readInbox: (bounds) => readWebhookInbox(input, bounds),
      completeWebhookDelivery: (token, bytes) =>
        completeWebhookDelivery(input, token, bytes),
    };
    return {
      state: input.state,
      persist: (event: HarnessMessageReadyEvent) =>
        persistInboxItem(input.store, event),
      queueLocalItem: queueLocalItem(input),
      operations: Object.freeze({
        ...invocations,
        readInboxSummary: input.store.readInboxSummary,
        readEvent: ({ eventId }: { readonly eventId: string }) =>
          input.collectives() === undefined
            ? notRegistered
            : readRuntimeEvent(input.store, eventId),
        readInbox: (request: HarnessReadInboxRequest) =>
          input.collectives() === undefined
            ? notRegistered
            : readAndExportInbox(input, request),
        acknowledgeDelivery: acknowledgeDelivery(input),
      }),
      eventStore,
    };
  }).pipe(Effect.withSpan("makeHostDelivery"));
