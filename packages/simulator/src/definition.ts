/** @file Definition-bound assembly of catalogs, services, rosters, and runs. */

import { Effect, type Layer, Schema } from "effect";
import { EventCatalog } from "./events/catalog.js";
import {
  makeDefinitionEventServices,
  type CustomerEvents,
  type ReadableRunLedger,
} from "./run/events.js";
import type { LedgerStorage } from "./ledger/storage.js";
import { runSociety } from "./run/execute.js";
import { Network, type NetworkService } from "./network/endpoint.js";
import type { RouterProvider } from "./network/router.js";
import type { Cluster } from "./cluster/cluster.js";
import {
  makeAgentRosterBinding,
  type AgentRoster,
  type StartedAgents,
} from "./agents/roster.js";
import type { AgentRuntimeLike } from "./agents/agent.js";

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
export type ClusterServices = LedgerStorage | RouterProvider | Cluster;

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

function provideCluster<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  ClusterLayerServices,
  ClusterLayerError,
  ClusterLayerRequirements,
>(
  eventServices: DefinitionEventServices<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  program: Effect.Effect<A, E, R>,
  cluster: Layer.Layer<
    ClusterLayerServices,
    ClusterLayerError,
    ClusterLayerRequirements
  >,
) {
  return runSociety({
    definitionId: roster.definitionId,
    eventServices,
    roster,
    program,
    options: {},
  }).pipe(Effect.provide(cluster));
}

type RunSpecExecution<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  ClusterLayer extends Layer.Layer<never, unknown, unknown>,
> = ReturnType<
  typeof provideCluster<
    Id,
    CustomerCatalogs,
    Definitions,
    A,
    E,
    R,
    Layer.Layer.Success<ClusterLayer>,
    Layer.Layer.Error<ClusterLayer>,
    Layer.Layer.Context<ClusterLayer>
  >
>;

type RunSpecRunner<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  ClusterLayer extends Layer.Layer<never, unknown, unknown>,
> = () => RunSpecExecution<
  Id,
  CustomerCatalogs,
  Definitions,
  A,
  E,
  R,
  ClusterLayer
>;

/**
 * A registered symbol, not a module-local one. The controller reaches an
 * experiment through a dynamic import, so a spec is routinely built in the
 * experiment's module graph and executed in the controller's; an unregistered
 * symbol differs between those copies and a correct spec would be rejected.
 */
const runSpecTypeId: unique symbol = Symbol.for("@moltzap/simulator/RunSpec");

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
  ClusterLayer extends Layer.Layer<
    never,
    unknown,
    unknown
  > = Layer.Layer<ClusterServices>,
> {
  /**
   * Present only on the exact values RunSpec.define produced, and carrying
   * their runner. This is the one identity gate: nothing structural
   * distinguishes a definition from a lookalike, and a lookalike has no
   * runner to invoke.
   */
  readonly [runSpecTypeId]?: RunSpecRunner<
    Id,
    CustomerCatalogs,
    Definitions,
    A,
    E,
    R,
    ClusterLayer
  >;
  readonly id: Id;
  readonly events: CustomerCatalogs;
  readonly agents: Definitions;
  readonly cluster: ClusterLayer &
    Layer.Layer<
      ClusterServices,
      Layer.Layer.Error<ClusterLayer>,
      Layer.Layer.Context<ClusterLayer>
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
  ClusterLayer extends Layer.Layer<never, unknown, unknown>,
>(
  cluster: ClusterLayer,
): Layer.Layer<
  Layer.Layer.Success<ClusterLayer>,
  Layer.Layer.Error<ClusterLayer>,
  Layer.Layer.Context<ClusterLayer>
>;
function concreteLayer(
  cluster: Layer.Layer<never, unknown, unknown>,
): Layer.Layer<never, unknown, unknown> {
  return cluster;
}

function makeRunSpecRunner<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  ClusterLayer extends Layer.Layer<never, unknown, unknown>,
>(
  eventServices: DefinitionEventServices<Id, CustomerCatalogs>,
  roster: AgentRoster<Id, Definitions>,
  execute: (
    context: RunExecutionContext<Id, CustomerCatalogs, Definitions>,
  ) => Effect.Effect<A, E, R>,
  cluster: ClusterLayer,
): RunSpecRunner<Id, CustomerCatalogs, Definitions, A, E, R, ClusterLayer> {
  const program = makeRunSpecProgram(eventServices, roster, execute);
  const providedCluster = concreteLayer(cluster);
  return () => provideCluster(eventServices, roster, program, providedCluster);
}

function defineRunSpec<
  const Id extends SimulatorDefinitionId,
  const CustomerCatalogs extends readonly AnyEventCatalog[],
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  const ClusterLayer extends Layer.Layer<never, unknown, unknown>,
>(
  input: RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, ClusterLayer>,
): RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, ClusterLayer> {
  const id = input.id;
  validateDefinitionId(id);
  const events = snapshotReadonlyArray(input.events);
  const cluster = input.cluster;
  const execute = input.execute;
  const customerCatalog = EventCatalog.merge(EventCatalog.empty(), ...events);
  const eventServices = makeDefinitionEventServices(id, customerCatalog);
  const roster = makeAgentRosterBinding(id).agents(input.agents);
  // Non-enumerable, so spreading a spec drops the brand: a copy carrying a
  // replaced execute must not silently run the original program.
  const spec: RunSpec<
    Id,
    CustomerCatalogs,
    Definitions,
    A,
    E,
    R,
    ClusterLayer
  > = Object.freeze(
    Object.defineProperty(
      { id, events, agents: roster.definitions, cluster, execute },
      runSpecTypeId,
      { value: makeRunSpecRunner(eventServices, roster, execute, cluster) },
    ),
  );
  return spec;
}

/**
 * Whether a value carries the brand RunSpec.define installs.
 * @param value Candidate produced elsewhere, typically a module export.
 * @returns Whether this simulator can execute the value as a RunSpec.
 */
export function isRunSpec(value: unknown): value is RunSpec {
  return typeof value === "object" && value !== null && runSpecTypeId in value;
}

function executeRunSpec<
  Id extends SimulatorDefinitionId,
  CustomerCatalogs extends readonly AnyEventCatalog[],
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
  ClusterLayer extends Layer.Layer<never, unknown, unknown>,
>(
  spec: RunSpec<Id, CustomerCatalogs, Definitions, A, E, R, ClusterLayer>,
): RunSpecExecution<Id, CustomerCatalogs, Definitions, A, E, R, ClusterLayer> {
  const runner = spec[runSpecTypeId];
  if (runner === undefined) {
    throw SimulatorDefinitionError.make({
      definitionId: spec.id,
      detail: "Run.execute requires a RunSpec produced by RunSpec.define",
    });
  }
  return runner();
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
