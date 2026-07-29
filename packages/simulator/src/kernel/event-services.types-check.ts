/**
 * @file Type canaries for definition-bound event services.
 *
 * A run ledger reads the exact core-plus-customer event universe, while the
 * customer event service writes only the definition's customer classes.
 */
import { Schema } from "effect";
import { EventCatalog } from "../events/catalog.js";
import { ProgramSucceeded, RunStarted } from "../events/core.js";
import { makeDefinitionEventServices } from "./event-services.js";

class CustomerObservation extends Schema.TaggedClass<CustomerObservation>()(
  "acme.customer-observation/v1",
  {
    result: Schema.String,
  },
) {}

class ForeignObservation extends Schema.TaggedClass<ForeignObservation>()(
  "other.foreign-observation/v1",
  {
    result: Schema.String,
  },
) {}

const customerCatalog = EventCatalog.make(CustomerObservation);
const services = makeDefinitionEventServices(
  "acme.mixed-society/v1",
  customerCatalog,
);

export function definitionEventServicesCanary(
  ledger: typeof services.Ledger.Service,
  events: typeof services.Events.Service,
): void {
  ledger.events(RunStarted);
  ledger.events(CustomerObservation);
  events.emit(CustomerObservation.make({ result: "observed" }));

  // @ts-expect-error core evidence is kernel-owned and not customer-writable
  events.emit(ProgramSucceeded.make());

  // @ts-expect-error undeclared classes are outside the readable catalog
  ledger.events(ForeignObservation);
}
