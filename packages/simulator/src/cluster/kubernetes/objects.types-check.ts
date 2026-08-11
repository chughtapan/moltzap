/**
 * A capacity reservation carries at least one runtime. An empty roster would
 * otherwise reach the cluster as a Workload admitting nothing, so the manifest
 * builder refuses it in its parameter type rather than at call time.
 */

import type { aggregateWorkloadManifest, ReservedCapacity } from "./objects.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type AggregateSlots = Parameters<typeof aggregateWorkloadManifest>[0]["slots"];

type ReservationSlotsAreNonEmpty = Expect<
  Equal<AggregateSlots, ReservedCapacity>
>;
type EmptyReservationIsUnrepresentable = Expect<
  Equal<readonly [] extends AggregateSlots ? true : false, false>
>;

/** Compile-time assertions for the aggregate capacity reservation. */
export type AggregateCapacityCanaries = [
  ReservationSlotsAreNonEmpty,
  EmptyReservationIsUnrepresentable,
];
