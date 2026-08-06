/**
 * @file Type canaries for definition-bound event services.
 *
 * A run ledger reads the exact core-plus-customer event universe, while the
 * customer event service writes only the definition's customer classes.
 */
import { Schema } from "effect";
import { EventCatalog } from "../events/catalog.js";
import { type ProgramSucceeded, RunStarted } from "../events/core.js";
import { makeDefinitionEventServices } from "./events.js";

class CustomerObservation extends Schema.TaggedClass<CustomerObservation>()(
  "acme.customer-observation/v1",
  {
    result: Schema.String,
  },
) {}

/** Event deliberately excluded from the definition's readable catalog. */
export class ForeignObservation extends Schema.TaggedClass<ForeignObservation>()(
  "other.foreign-observation/v1",
  {
    result: Schema.String,
  },
) {}

const customerCatalog = EventCatalog.make(CustomerObservation);
/** Representative services retained for compile-time ownership checks. */
export const definitionEventServices = makeDefinitionEventServices(
  "acme.mixed-society/v1",
  customerCatalog,
);

/**
 * Executes the definition event services canary operation.
 * @param ledger Value supplied to the operation.
 * @param events Value supplied to the operation.
 */
export function definitionEventServicesCanary(
  ledger: typeof definitionEventServices.ledger.Service,
  events: typeof definitionEventServices.events.Service,
): void {
  ledger.events(RunStarted);
  ledger.events(CustomerObservation);
  events.emit(CustomerObservation.make({ result: "observed" }));
}

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;
type WritableEvent = Parameters<
  typeof definitionEventServices.events.Service.emit
>[0];
type ReadableEventClass = Parameters<
  typeof definitionEventServices.ledger.Service.events
>[0];
type CustomerEventIsWritable = Expect<
  Equal<CustomerObservation extends WritableEvent ? true : false, true>
>;
type CoreEventIsKernelOwned = Expect<
  Equal<ProgramSucceeded extends WritableEvent ? true : false, false>
>;
type CustomerEventIsReadable = Expect<
  Equal<
    typeof CustomerObservation extends ReadableEventClass ? true : false,
    true
  >
>;
type ForeignEventIsNotReadable = Expect<
  Equal<
    typeof ForeignObservation extends ReadableEventClass ? true : false,
    false
  >
>;

/** Compile-time assertions for definition-bound event ownership. */
export type DefinitionEventServiceCanaries = [
  CustomerEventIsWritable,
  CoreEventIsKernelOwned,
  CustomerEventIsReadable,
  ForeignEventIsNotReadable,
];
