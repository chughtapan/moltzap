/** @file Definition-bound assembly of catalogs, services, rosters, and runs. */

import { Effect, type Layer, Schema } from "effect";
import type { AgentRuntimeLike } from "./agents/agent.js";
import type { AgentRoster, StartedAgents } from "./agents/index.js";
import type { Cluster } from "./cluster/cluster.js";
import type { LedgerStorage } from "./ledger/index.js";
import { makeAgentRosterBinding } from "./agents/roster.js";
import { EventCatalog } from "./events/catalog.js";
import {
  Network,
  type NetworkService,
  type RouterProvider,
} from "./network/index.js";
import {
  type CustomerEvents,
  makeDefinitionEventServices,
  type ReadableRunLedger,
} from "./run/events.js";
import { runSociety } from "./run/execute.js";

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

/**
 * Whether a value carries the brand RunSpec.define installs.
 * @param value Candidate produced elsewhere, typically a module export.
 * @returns Whether this simulator can execute the value as a RunSpec.
 */
export function isRunSpec(value: unknown): value is RunSpec {
  return hasRunSpecBrand(value);
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
  readonly [runSpecTypeId]?: () => RunSpecExecution<
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

function hasRunSpecBrand(value: unknown): boolean {
  return typeof value === "object" && value !== null && runSpecTypeId in value;
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
  const catalogs = snapshotReadonlyArray(input.events);
  const cluster = input.cluster;
  const execute = input.execute;
  const customerCatalog = EventCatalog.merge(EventCatalog.empty(), ...catalogs);
  const eventServices = makeDefinitionEventServices(id, customerCatalog);
  const roster = makeAgentRosterBinding(id).agents(input.agents);
  const program = Effect.gen(function* () {
    const agents = yield* roster.startedAgents;
    const events = yield* eventServices.events;
    const network = yield* Network;
    const ledger = yield* eventServices.ledger;
    const context: RunExecutionContext<Id, CustomerCatalogs, Definitions> =
      Object.freeze({ agents, events, network, ledger });
    return yield* Effect.suspend(() => execute(context));
  });
  const spec: RunSpec<
    Id,
    CustomerCatalogs,
    Definitions,
    A,
    E,
    R,
    ClusterLayer
  > = {
    id,
    events: catalogs,
    agents: roster.definitions,
    cluster,
    execute,
    [runSpecTypeId]: () =>
      provideCluster(eventServices, roster, program, concreteLayer(cluster)),
  };
  // Non-enumerable, so spreading a spec drops the brand: a copy carrying a
  // replaced execute must not silently run the original program.
  Object.defineProperty(spec, runSpecTypeId, { enumerable: false });
  return Object.freeze(spec);
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

function snapshotReadonlyArray<const Values extends readonly unknown[]>(
  values: Values,
): Values;
function snapshotReadonlyArray(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze([...values]);
}

// An opaque ClusterLayer is not assignable to the projection of its own type
// parameters, so the widening lives in this overload pair rather than in an
// annotation. Passing the layer unwidened infers the constrained
// Layer<never, unknown, unknown> instead, which drops the layer's exact
// outputs from the run's type and leaves extra outputs unsatisfied.
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
