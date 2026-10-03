/** @file Process-local delivery bookkeeping shared by the delivery pass and host operations. */

import { Effect } from "effect";
import type { DeliveryToken } from "../store/types.js";
import type { InboundItem } from "../transport/collectives/inbound.js";

/**
 * One instance per service, shared by the delivery pass, host reads,
 * acknowledgments and webhook receipts. `gate` serializes those so an item is
 * exported once and retired once. Emitting a local item never waits on it:
 * the collective layer can emit from inside a pass that already holds it.
 */
export interface DeliveryState {
  readonly gate: Effect.Semaphore;
  /** Deliveries the attached subscriber already took. */
  readonly publishedDeliveries: Set<string>;
  /** Deliveries whose item the history export already recorded. */
  readonly exportedDeliveries: Set<string>;
  /** The item each unacknowledged durable delivery classified into. */
  readonly classifiedItems: Map<string, InboundItem>;
  /**
   * Items the collective layer emitted, in emission order, each under a
   * service-minted delivery token until the host acknowledges it. They are
   * durable before insertion; this map caches the current process values.
   */
  readonly localItems: Map<DeliveryToken, InboundItem>;
}

/** Empty delivery state with its own gate. */
export const makeDeliveryState: Effect.Effect<DeliveryState> = Effect.map(
  Effect.makeSemaphore(1),
  (gate) => ({
    gate,
    publishedDeliveries: new Set(),
    exportedDeliveries: new Set(),
    classifiedItems: new Map(),
    localItems: new Map(),
  }),
);

/**
 * Drop a retired delivery from every process-local cache.
 * @param state The shared delivery state.
 * @param deliveryToken The retired delivery.
 * @returns Completion once the caches no longer hold it.
 */
export const forgetDelivery = (
  state: DeliveryState,
  deliveryToken: DeliveryToken,
): Effect.Effect<void> =>
  Effect.sync(() => {
    state.publishedDeliveries.delete(deliveryToken);
    state.exportedDeliveries.delete(deliveryToken);
    state.classifiedItems.delete(deliveryToken);
    state.localItems.delete(deliveryToken);
  });
