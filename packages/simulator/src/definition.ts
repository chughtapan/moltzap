/** @file Definition-bound assembly of catalogs, services, rosters, and runs. */

import { Effect, Schema } from "effect";
import { EventCatalog, type EventClass } from "./events/catalog.js";
import { makeDefinitionEventServices } from "./kernel/event-services.js";
import {
  openLedger,
  type CompletedRunLedger,
  type LedgerOpenError,
} from "./ledger/open.js";
import type { JsonObject, JsonValue, LedgerRef } from "./ledger/model.js";
import type { LedgerStorage } from "./ledger/storage.js";
import { runSociety, type SimulatorRunOptions } from "./kernel/run.js";
import {
  makeAgentRosterBinding,
  makeAgentRosterBuilder,
  type AgentRoster,
} from "./runtime/roster.js";
import type { AgentRuntimeLike } from "./runtime/runtime.js";

/** Stable code identity persisted in every ledger manifest. */
export type SimulatorDefinitionId = `${string}.${string}/v${number}`;

const DEFINITION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u;

export class SimulatorDefinitionError extends Schema.TaggedError<SimulatorDefinitionError>()(
  "SimulatorDefinitionError",
  {
    definitionId: Schema.String,
    detail: Schema.NonEmptyString,
  },
) {
  override get message(): string {
    return `Simulator definition "${this.definitionId}" is invalid: ${this.detail}`;
  }
}

function validateDefinitionId(
  definitionId: string,
): asserts definitionId is SimulatorDefinitionId {
  if (!DEFINITION_ID.test(definitionId)) {
    throw SimulatorDefinitionError.make({
      definitionId,
      detail:
        "the id must be namespaced and versioned, for example acme.society/v1",
    });
  }
}

type AnyEventCatalog = EventCatalog<Schema.Schema.AnyNoContext, EventClass>;
type EmptyEventCatalog = ReturnType<typeof EventCatalog.empty>;
type CustomerEventCatalog<
  CustomerCatalogs extends ReadonlyArray<AnyEventCatalog>,
> = ReturnType<
  typeof EventCatalog.merge<readonly [EmptyEventCatalog, ...CustomerCatalogs]>
>;
type CatalogSchemaOf<Catalog> =
  Catalog extends EventCatalog<infer SchemaType, infer _Classes>
    ? SchemaType
    : never;
type CatalogClassesOf<Catalog> =
  Catalog extends EventCatalog<infer _SchemaType, infer Classes>
    ? Classes
    : never;
type DefinitionEventServices<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends ReadonlyArray<AnyEventCatalog>,
> = ReturnType<
  typeof makeDefinitionEventServices<
    Id,
    CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
    CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
  >
>;

function isJsonArray(value: JsonValue): value is ReadonlyArray<JsonValue> {
  return Array.isArray(value);
}

function snapshotJsonValue(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return Object.freeze(value.map(snapshotJsonValue));
  }
  if (typeof value === "object" && value !== null) {
    return snapshotJsonObject(value);
  }
  return value;
}

function snapshotJsonObject(value: JsonObject): JsonObject {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        snapshotJsonValue(entry),
      ]),
    ),
  );
}

function snapshotRunOptions(options: SimulatorRunOptions): SimulatorRunOptions {
  return Object.freeze({
    ...(options.provenance === undefined
      ? {}
      : { provenance: snapshotJsonObject(options.provenance) }),
    ...(options.metadata === undefined
      ? {}
      : { metadata: snapshotJsonObject(options.metadata) }),
  });
}

function makeRunner<
  const Id extends SimulatorDefinitionId,
  CustomerSchema extends Schema.Schema.AnyNoContext,
  CustomerClasses extends EventClass,
>(
  definitionId: Id,
  eventServices: ReturnType<
    typeof makeDefinitionEventServices<Id, CustomerSchema, CustomerClasses>
  >,
  ownsRoster: ReturnType<typeof makeAgentRosterBinding<Id>>["owns"],
) {
  return <
    const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
    A = unknown,
    E = unknown,
    R = never,
  >(
    roster: AgentRoster<Id, Definitions>,
    program: Effect.Effect<A, E, R>,
    options: SimulatorRunOptions = {},
  ) => {
    if (!ownsRoster(roster)) {
      throw SimulatorDefinitionError.make({
        definitionId,
        detail:
          "the roster must be created by this definition's agents function",
      });
    }
    const capturedOptions = snapshotRunOptions(options);
    return runSociety({
      definitionId,
      eventServices,
      roster,
      program,
      options: capturedOptions,
    });
  };
}

function makeLedgerReader<
  const Id extends SimulatorDefinitionId,
  CustomerSchema extends Schema.Schema.AnyNoContext,
  CustomerClasses extends EventClass,
>(
  definitionId: Id,
  eventServices: ReturnType<
    typeof makeDefinitionEventServices<Id, CustomerSchema, CustomerClasses>
  >,
) {
  return (
    ref: LedgerRef,
  ): Effect.Effect<
    CompletedRunLedger<typeof eventServices.catalog>,
    LedgerOpenError,
    LedgerStorage
  > => openLedger(eventServices.catalog, ref, definitionId);
}

/** Definition-bound capabilities for one versioned family of simulator runs. */
export interface SimulatorDefinition<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends ReadonlyArray<AnyEventCatalog>,
> {
  readonly id: Id;
  readonly catalog: DefinitionEventServices<Id, CustomerCatalogs>["catalog"];
  readonly customerCatalog: CustomerEventCatalog<CustomerCatalogs>;
  readonly Ledger: DefinitionEventServices<Id, CustomerCatalogs>["Ledger"];
  readonly Events: DefinitionEventServices<Id, CustomerCatalogs>["Events"];
  readonly agents: ReturnType<typeof makeAgentRosterBuilder<Id>>;
  readonly run: ReturnType<
    typeof makeRunner<
      Id,
      CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
      CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
    >
  >;
  readonly openLedger: ReturnType<
    typeof makeLedgerReader<
      Id,
      CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
      CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
    >
  >;
}

/**
 * Define the exact code and event universe for a family of simulator runs.
 * Invalid definitions fail here, before any platform resource is acquired.
 */
function defineSimulator<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends ReadonlyArray<AnyEventCatalog>,
>(
  definitionId: Id,
  ...customerCatalogs: CustomerCatalogs
): SimulatorDefinition<Id, CustomerCatalogs> {
  validateDefinitionId(definitionId);
  const customerCatalog = EventCatalog.merge(
    EventCatalog.empty(),
    ...customerCatalogs,
  );
  const eventServices = makeDefinitionEventServices(
    definitionId,
    customerCatalog,
  );
  const rosterBinding = makeAgentRosterBinding(definitionId);
  const open = makeLedgerReader(definitionId, eventServices);

  return Object.freeze({
    id: definitionId,
    catalog: eventServices.catalog,
    customerCatalog: eventServices.customerCatalog,
    Ledger: eventServices.Ledger,
    Events: eventServices.Events,
    agents: rosterBinding.agents,
    run: makeRunner(definitionId, eventServices, rosterBinding.owns),
    openLedger: open,
  });
}

/** Discoverable entry point for code-first society definitions. */
export const Simulator: Readonly<{ define: typeof defineSimulator }> =
  Object.freeze({
    define: defineSimulator,
  });
