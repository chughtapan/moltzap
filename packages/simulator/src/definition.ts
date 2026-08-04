/** @file Definition-bound assembly of catalogs, services, rosters, and runs. */

import { Effect, type Layer, type Scope, Schema, type Tracer } from "effect";
import { EventCatalog, type EventClass } from "./events/catalog.js";
import {
  makeDefinitionEventServices,
  type CustomerEvents,
  type ReadableRunLedger,
} from "./kernel/event-services.js";
import {
  openLedger,
  type CompletedRunLedger,
  type LedgerOpenError,
} from "./ledger/open.js";
import type { JsonObject, JsonValue, LedgerRef } from "./ledger/model.js";
import type { LedgerStorage } from "./ledger/storage.js";
import { runSociety, type SimulatorRunOptions } from "./kernel/run.js";
import { Network, type NetworkService } from "./network/endpoint.js";
import type { RouterProvider } from "./network/router.js";
import {
  makeAgentRosterBinding,
  type makeAgentRosterBuilder,
  type AgentRoster,
  type AgentRosterRequirements,
  type StartedAgents,
} from "./runtime/roster.js";
import type { AgentRuntimeLike } from "./runtime/runtime.js";

/** Stable code identity persisted in every ledger manifest. */
export type SimulatorDefinitionId = `${string}.${string}/v${number}`;

const DEFINITION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/v[1-9]\d*$/u;

/** Reports simulator definition failures. */
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

type AnyEventCatalog = EventCatalog<Schema.Schema.AnyNoContext>;
type EmptyEventCatalog = ReturnType<typeof EventCatalog.empty>;
type CustomerEventCatalog<CustomerCatalogs extends readonly AnyEventCatalog[]> =
  ReturnType<
    typeof EventCatalog.merge<readonly [EmptyEventCatalog, ...CustomerCatalogs]>
  >;
type CatalogParameters<Catalog> =
  Catalog extends EventCatalog<infer SchemaType, infer Classes>
    ? readonly [SchemaType, Classes]
    : never;
type CatalogSchemaOf<Catalog> = CatalogParameters<Catalog>[0];
type CatalogClassesOf<Catalog> = CatalogParameters<Catalog>[1];
type DefinitionEventServices<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
> = ReturnType<
  typeof makeDefinitionEventServices<
    Id,
    CatalogSchemaOf<CustomerEventCatalog<CustomerCatalogs>>,
    CatalogClassesOf<CustomerEventCatalog<CustomerCatalogs>>
  >
>;

type RunInfrastructureServices<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> =
  | LedgerStorage
  | RouterProvider
  | Exclude<
      AgentRosterRequirements<Definitions>,
      Scope.Scope | Tracer.ParentSpan
    >;

interface RunExecutionContext<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly agents: StartedAgents<Definitions>;
  readonly events: CustomerEvents<CustomerEventCatalog<CustomerCatalogs>>;
  readonly network: NetworkService;
  readonly ledger: ReadableRunLedger<
    DefinitionEventServices<Id, CustomerCatalogs>["catalog"]
  >;
}

function provideRunInfrastructure<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  InfrastructureServices,
  InfrastructureError,
  InfrastructureRequirements,
>(
  definition: SimulatorDefinition<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  program: Effect.Effect<A, E, R>,
  infrastructure: Layer.Layer<
    InfrastructureServices,
    InfrastructureError,
    InfrastructureRequirements
  >,
) {
  return definition.run(roster, program).pipe(Effect.provide(infrastructure));
}

type RunSpecExecution<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
> = ReturnType<
  typeof provideRunInfrastructure<
    Id,
    CustomerCatalogs,
    Definitions,
    A,
    E,
    R,
    Layer.Layer.Success<Infrastructure>,
    Layer.Layer.Error<Infrastructure>,
    Layer.Layer.Context<Infrastructure>
  >
>;

type RunSpecRunner<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
> = () => RunSpecExecution<
  Id,
  CustomerCatalogs,
  Definitions,
  A,
  E,
  R,
  Infrastructure
>;

type AnyRunSpecRunner = () => Effect.Effect<unknown, unknown, unknown>;

const runSpecRunners = new WeakMap<object, AnyRunSpecRunner>();

/** Immutable code-first definition of one experiment society. */
export interface RunSpec<
  Id extends SimulatorDefinitionId = SimulatorDefinitionId,
  CustomerCatalogs extends
    readonly AnyEventCatalog[] = readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>> = Readonly<
    Record<string, AgentRuntimeLike>
  >,
  A = unknown,
  E = unknown,
  R = never,
  Infrastructure extends Layer.Layer<never, unknown, unknown> = Layer.Layer<
    RunInfrastructureServices<Definitions>
  >,
> {
  readonly id: Id;
  readonly events: CustomerCatalogs;
  readonly agents: Definitions;
  readonly infrastructure: Infrastructure &
    Layer.Layer<
      RunInfrastructureServices<Definitions>,
      Layer.Layer.Error<Infrastructure>,
      Layer.Layer.Context<Infrastructure>
    >;
  readonly execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>;
}

function snapshotReadonlyArray<const Values extends readonly unknown[]>(
  values: Values,
): Values;
function snapshotReadonlyArray(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze([...values]);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
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
  CustomerCatalogs extends readonly AnyEventCatalog[],
> {
  readonly id: Id;
  readonly catalog: DefinitionEventServices<Id, CustomerCatalogs>["catalog"];
  readonly customerCatalog: CustomerEventCatalog<CustomerCatalogs>;
  readonly ledger: DefinitionEventServices<Id, CustomerCatalogs>["ledger"];
  readonly events: DefinitionEventServices<Id, CustomerCatalogs>["events"];
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
 * @param definitionId Value supplied to the operation.
 * @param customerCatalogs Value supplied to the operation.
 * @returns The define simulator result.
 */
function defineSimulator<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
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
    ledger: eventServices.ledger,
    events: eventServices.events,
    agents: rosterBinding.agents,
    run: makeRunner(definitionId, eventServices, rosterBinding.owns),
    openLedger: open,
  });
}

function makeRunSpecProgram<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  definition: SimulatorDefinition<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const events = yield* definition.events;
    const network = yield* Network;
    const ledger = yield* definition.ledger;
    const context: RunExecutionContext<Id, CustomerCatalogs, Definitions> =
      Object.freeze({ agents, events, network, ledger });
    return yield* Effect.suspend(() => execute(context));
  });
}

function concreteLayer<
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
>(
  infrastructure: Infrastructure,
): Layer.Layer<
  Layer.Layer.Success<Infrastructure>,
  Layer.Layer.Error<Infrastructure>,
  Layer.Layer.Context<Infrastructure>
>;
function concreteLayer(
  infrastructure: Layer.Layer<never, unknown, unknown>,
): Layer.Layer<never, unknown, unknown> {
  return infrastructure;
}

function makeRunSpecRunner<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
>(
  definition: SimulatorDefinition<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>,
  infrastructure: Infrastructure,
): RunSpecRunner<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure> {
  const program = makeRunSpecProgram(definition, roster, execute);
  const providedInfrastructure = concreteLayer(infrastructure);
  return () =>
    provideRunInfrastructure(
      definition,
      roster,
      program,
      providedInfrastructure,
    );
}

function defineRunSpec<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  const Infrastructure extends Layer.Layer<never, unknown, unknown>,
>(
  input: RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure>,
): RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure> {
  const id = input.id;
  const events = snapshotReadonlyArray(input.events);
  const infrastructure = input.infrastructure;
  const execute = input.execute;
  const definition = defineSimulator(id, ...events);
  const roster = definition.agents(input.agents);
  const run = makeRunSpecRunner(definition, roster, execute, infrastructure);
  const spec = Object.freeze({
    id: definition.id,
    events,
    agents: roster.definitions,
    infrastructure,
    execute,
  });
  runSpecRunners.set(spec, run);
  return spec;
}

function runSpecRunnerFor<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
>(
  spec: RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure>,
): RunSpecRunner<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure>;
function runSpecRunnerFor(spec: object): AnyRunSpecRunner {
  const runner = runSpecRunners.get(spec);
  if (runner === undefined) {
    throw SimulatorDefinitionError.make({
      definitionId: "unknown",
      detail: "Run.execute requires the exact value returned by RunSpec.define",
    });
  }
  return runner;
}

function executeRunSpec<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  Infrastructure extends Layer.Layer<never, unknown, unknown>,
>(
  spec: RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure>,
): RunSpecExecution<
  Id,
  CustomerCatalogs,
  Definitions,
  A,
  E,
  R,
  Infrastructure
> {
  return runSpecRunnerFor(spec)();
}

/** Discoverable constructor for immutable experiment definitions. */
// eslint-disable-next-line @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- the public namespace and its merged type intentionally share the accepted RunSpec spelling.
export const RunSpec: Readonly<{ define: typeof defineRunSpec }> =
  Object.freeze({ define: defineRunSpec });

/** Discoverable execution entry point for one experiment society. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the public execution namespace uses the accepted Run.execute spelling.
export const Run: Readonly<{ execute: typeof executeRunSpec }> = Object.freeze({
  execute: executeRunSpec,
});

/** Discoverable entry point for code-first society definitions. */
export const simulator: Readonly<{ define: typeof defineSimulator }> =
  Object.freeze({
    define: defineSimulator,
  });
