/** @file One service's delivery: the inbox writes, the gated delivery pass and detach, and the operations hosts call. */

import { DateTime, Effect, type Scope } from "effect";
import type { SendInput } from "../transport/collectives/forms.js";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type { EnginePendingMessage } from "../transport/messaging/index.js";
import type {
  HistoryExportPort,
  HistoryExportRecord,
} from "./history-export.js";
import type {
  DeliveryOperations,
  EventStore,
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
import {
  type DeliveryState,
  exportOnce,
  forgetDelivery,
  makeDeliveryState,
  offerPendingMessages,
  type PendingOffer,
} from "./pass.js";
import { makeSendInvocations } from "./send-invocations.js";

/** What one service's delivery reads and writes. */
export interface HostDeliveryInput {
  readonly store: EndpointStore;
  readonly historyExport: HistoryExportPort;
  /** The active collective layer, absent while the service is unregistered. */
  readonly collectives: () => Pick<CollectiveOperations, "send"> | undefined;
  /** Service lifetime, independent of any host request. */
  readonly scope: Scope.Scope;
}

/**
 * What the service supplies to one pass: the active protocol's pending read,
 * acknowledgment and classifier, and the attached subscriber if any.
 */
interface PassInput<E>
  extends Pick<PendingOffer, "engine" | "classify" | "handler"> {
  readonly readPending: Effect.Effect<readonly EnginePendingMessage[], E>;
}

/** One service's delivery, created once and shared by the delivery pass and every host operation. */
export interface HostDelivery {
  readonly operations: DeliveryOperations;
  readonly eventStore: EventStore;
  /** Forget what the departed subscriber took, so the next one is offered it again. */
  readonly detach: Effect.Effect<void>;
  /**
   * Run one pass under the delivery gate. `prepare` runs once the gate is
   * held, so the active protocol and subscriber it reads are current; it
   * returns undefined when there is nothing to run. A store failure ends the
   * pass and releases the gate.
   */
  readonly runPass: <E>(
    prepare: () => PassInput<E> | undefined,
  ) => Effect.Effect<void, E | EndpointStoreError>;
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

/**
 * Read one inbox page under the delivery gate and export each entry's item
 * once, so native and webhook reads share the pass's export ordering.
 */
const readExported = <
  Page extends {
    readonly items: ReadonlyArray<{ readonly deliveryToken: DeliveryToken }>;
  },
  E,
>(
  input: DeliveryContext,
  read: Effect.Effect<Page, E>,
  itemOf: (entry: Page["items"][number]) => Effect.Effect<InboundItem, E>,
) =>
  input.state.gate.withPermits(1)(
    read.pipe(
      Effect.tap((page) =>
        Effect.forEach(
          page.items,
          (entry) =>
            exportOnce(
              input.state,
              input.historyExport,
              entry.deliveryToken,
              itemOf(entry),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
  );

/** Export replayed local items before a host can read them after restart. */
const readAndExportInbox = (
  input: DeliveryContext,
  request: HarnessReadInboxRequest,
) =>
  readExported(input, readRuntimeInbox(input.store, request), (entry) =>
    Effect.succeed(entry.item),
  );

/** The webhook's raw page, decoding each stored item only to export it. */
const readWebhookInbox = (
  input: DeliveryContext,
  bounds: Parameters<EndpointStore["readInbox"]>[0],
) =>
  readExported(input, input.store.readInbox(bounds), (entry) =>
    decodeRuntimeValue(InboundItem, entry.canonicalItem),
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

/** The pass's view of the service's delivery and the protocol it serves. */
const pendingOffer = <E>(
  input: DeliveryContext,
  pass: PassInput<E>,
): PendingOffer => ({
  engine: pass.engine,
  classify: pass.classify,
  ...(pass.handler === undefined ? {} : { handler: pass.handler }),
  persist: (event) => persistInboxItem(input.store, event),
  historyExport: input.historyExport,
  state: input.state,
});

const runPass = <E>(
  input: DeliveryContext,
  prepare: () => PassInput<E> | undefined,
): Effect.Effect<void, E | EndpointStoreError> =>
  input.state.gate.withPermits(1)(
    Effect.suspend(() => {
      const pass = prepare();
      if (pass === undefined) {
        return Effect.void;
      }
      return pass.readPending.pipe(
        Effect.flatMap((messages) =>
          offerPendingMessages(pendingOffer(input, pass), messages),
        ),
      );
    }),
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
      detach: Effect.sync(() => {
        input.state.publishedDeliveries.clear();
      }),
      runPass: <E>(prepare: () => PassInput<E> | undefined) =>
        runPass(input, prepare),
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
