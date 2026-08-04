/** @file Definition-bound assembly of catalogs, services, rosters, and runs. */

import { Effect, type Layer, Schema } from "effect";
import { EventCatalog } from "./events/catalog.js";
import {
  makeDefinitionEventServices,
  type CustomerEvents,
  type ReadableRunLedger,
} from "./kernel/event-services.js";
import type { LedgerStorage } from "./ledger/storage.js";
import { runSociety } from "./kernel/run.js";
import { Network, type NetworkService } from "./network/endpoint.js";
import type { RouterProvider } from "./network/router.js";
import type { SocietyPlatform } from "./platform/platform.js";
import {
  makeAgentRosterBinding,
  type AgentRoster,
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

/** Opaque service set supplied by a local-Kubernetes or GKE Layer. */
export type RunInfrastructureServices =
  | LedgerStorage
  | RouterProvider
  | SocietyPlatform;

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
  eventServices: DefinitionEventServices<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  program: Effect.Effect<A, E, R>,
  infrastructure: Layer.Layer<
    InfrastructureServices,
    InfrastructureError,
    InfrastructureRequirements
  >,
) {
  return runSociety({
    definitionId: roster.definitionId,
    eventServices,
    roster,
    program,
    options: {},
  }).pipe(Effect.provide(infrastructure));
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
  Infrastructure extends Layer.Layer<
    never,
    unknown,
    unknown
  > = Layer.Layer<RunInfrastructureServices>,
> {
  readonly id: Id;
  readonly events: CustomerCatalogs;
  readonly agents: Definitions;
  readonly infrastructure: Infrastructure &
    Layer.Layer<
      RunInfrastructureServices,
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

function makeRunSpecProgram<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  eventServices: DefinitionEventServices<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const events = yield* eventServices.events;
    const network = yield* Network;
    const ledger = yield* eventServices.ledger;
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
  eventServices: DefinitionEventServices<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>,
  infrastructure: Infrastructure,
): RunSpecRunner<Id, CustomerCatalogs, Definitions, A, E, R, Infrastructure> {
  const program = makeRunSpecProgram(eventServices, roster, execute);
  const providedInfrastructure = concreteLayer(infrastructure);
  return () =>
    provideRunInfrastructure(
      eventServices,
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
  validateDefinitionId(id);
  const events = snapshotReadonlyArray(input.events);
  const infrastructure = input.infrastructure;
  const execute = input.execute;
  const customerCatalog = EventCatalog.merge(EventCatalog.empty(), ...events);
  const eventServices = makeDefinitionEventServices(id, customerCatalog);
  const roster = makeAgentRosterBinding(id).agents(input.agents);
  const run = makeRunSpecRunner(eventServices, roster, execute, infrastructure);
  const spec = Object.freeze({
    id,
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
