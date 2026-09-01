/** @file Definition-bound readable-ledger and customer-event Effect services. */

import { Context, type Effect, Layer, type Schema, type Stream } from "effect";
import type { LedgerWriter } from "../ledger/append.js";
import type {
  LedgerFailure,
  LedgerManifest,
  LedgerRecord,
  LedgerRef,
  RunLedger,
} from "../ledger/index.js";
import {
  EventCatalog,
  type EventClass,
  type EventClassOf,
  type EventOf,
} from "../events/catalog.js";
import { coreEvents } from "../events/core.js";

type CatalogSchema = Schema.Schema.All;
type AnyEventCatalog = EventCatalog<CatalogSchema>;

let nextDefinitionServicesId = 0;

/** Causality metadata accepted from a customer event producer. */
export interface EventMetadata {
  readonly causationId?: string;
  readonly correlationId?: string;
}

/** Definition-bound read access to every committed core and customer event. */
export interface ReadableRunLedger<Catalog extends AnyEventCatalog> {
  readonly ref: LedgerRef;
  readonly manifest: LedgerManifest;
  readonly records: Stream.Stream<LedgerRecord<Catalog>, LedgerFailure>;
  readonly events: <Event extends EventClassOf<Catalog>>(
    eventClass: Event,
  ) => Stream.Stream<Schema.Schema.Type<Event>, LedgerFailure>;
}

/** Definition-bound emission of customer-owned event classes only. */
export interface CustomerEvents<Catalog extends AnyEventCatalog> {
  readonly emit: (
    event: EventOf<Catalog>,
    metadata?: EventMetadata,
  ) => Effect.Effect<LedgerRecord<Catalog>, LedgerFailure>;
}

/**
 * Close one definition over its readable core-plus-customer catalog and its
 * customer-only writable catalog. The returned tags are unique to this
 * definition value and are provided once at the run boundary.
 * @param definitionId Stable identity used to namespace this definition's services.
 * @param customerCatalog Customer-owned event variants accepted for emission.
 * @returns Definition-bound tags, merged catalog, and service-layer constructor.
 */
export function makeDefinitionEventServices<
  const Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
>(
  definitionId: Id,
  customerCatalog: EventCatalog<CustomerSchema, CustomerClasses>,
) {
  const catalog = EventCatalog.merge(coreEvents, customerCatalog);
  type ReadableCatalog = typeof catalog;
  type CustomerCatalog = typeof customerCatalog;
  const services = makeServiceTags(definitionId, catalog, customerCatalog);

  const layer = (
    ledger: RunLedger<ReadableCatalog>,
    customerWriter: LedgerWriter<CustomerCatalog>,
  ) =>
    Layer.merge(
      Layer.succeed(services.ledger, makeReadableRunLedger(ledger)),
      Layer.succeed(services.events, makeCustomerEvents(customerWriter)),
    );

  return Object.freeze({
    ...services,
    layer,
  });
}

function nonEmpty(value?: string): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function makeReadableRunLedger<Catalog extends AnyEventCatalog>(
  ledger: RunLedger<Catalog>,
): ReadableRunLedger<Catalog> {
  return Object.freeze({
    ref: ledger.ref,
    manifest: ledger.manifest,
    records: ledger.records,
    events: <Event extends EventClassOf<Catalog>>(eventClass: Event) =>
      ledger.events(eventClass),
  });
}

function makeCustomerEvents<Catalog extends AnyEventCatalog>(
  writer: LedgerWriter<Catalog>,
): CustomerEvents<Catalog> {
  return Object.freeze({
    emit: (event: EventOf<Catalog>, metadata: EventMetadata = {}) => {
      const causationId = nonEmpty(metadata.causationId);
      const correlationId = nonEmpty(metadata.correlationId);
      return writer.write({
        event,
        ...(causationId === undefined ? {} : { causationId }),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
    },
  });
}

function makeServiceTags<
  const Id extends string,
  ReadableCatalog extends AnyEventCatalog,
  CustomerCatalog extends AnyEventCatalog,
>(
  definitionId: Id,
  catalog: ReadableCatalog,
  customerCatalog: CustomerCatalog,
) {
  nextDefinitionServicesId += 1;
  const instanceId = nextDefinitionServicesId;
  const ledgerValue = Context.GenericTag<
    {
      readonly definitionId: Id;
      readonly readableEvent: EventOf<ReadableCatalog>;
    },
    ReadableRunLedger<ReadableCatalog>
  >(`@moltzap/simulator/${definitionId}/Ledger/${instanceId}`);
  const eventsValue = Context.GenericTag<
    {
      readonly definitionId: Id;
      readonly customerEvent: EventOf<CustomerCatalog>;
    },
    CustomerEvents<CustomerCatalog>
  >(`@moltzap/simulator/${definitionId}/Events/${instanceId}`);
  return Object.freeze({
    catalog,
    customerCatalog,
    ledger: ledgerValue,
    events: eventsValue,
  });
}
