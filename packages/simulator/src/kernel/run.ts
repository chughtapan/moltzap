/** @file Allocation, execution, and ordered finalization of one run. */

import {
  type Context,
  Effect,
  Exit,
  Layer,
  Ref,
  type Schema,
  type Scope,
} from "effect";
import {
  endpointEvents,
  linkEvents,
  routerEvents,
  runEvents,
  RunStarted,
  runtimeEvents,
} from "../events/core.js";
import type { EventClass } from "../events/catalog.js";
import {
  makeRunLedger,
  type ActiveRunLedger,
  type LedgerFailure,
  type LedgerWriter,
} from "../ledger/live.js";
import type {
  JsonObject,
  LedgerCompletion,
  LedgerRef,
} from "../ledger/model.js";
import type { LedgerStorage } from "../ledger/storage.js";
import { LinkController, type LinkControllerService } from "../network/link.js";
import { Network, type NetworkService } from "../network/endpoint.js";
import type {
  RouterProvider,
  NetworkFailure,
  Router,
} from "../network/router.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  AgentRosterRequirements,
  StartedAgentHandles,
} from "../runtime/roster.js";
import type { AgentRuntimeLike } from "../runtime/runtime.js";
import { combinedFailure, programEvent } from "./outcomes.js";
import { makeNetworkService } from "./endpoints.js";
import { makeLinkController } from "./links.js";
import { acquireRoster } from "./runtimes.js";
import { acquireRouter, recordStoppedRouter } from "./router.js";
import type { makeDefinitionEventServices } from "./event-services.js";

type CatalogSchema = Schema.Schema.AnyNoContext;

type DefinitionEventServices<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
> = ReturnType<
  typeof makeDefinitionEventServices<Id, CustomerSchema, CustomerClasses>
>;

/** Optional run metadata; platform and runtime policy belong in Layers. */
export interface SimulatorRunOptions {
  readonly provenance?: JsonObject;
  readonly metadata?: JsonObject;
}

/** The program Exit plus the durable ledger that proves the run. */
export interface SimulatorRunResult<A, E> {
  readonly exit: Exit.Exit<A, E>;
  readonly ledger: LedgerRef;
  readonly completion: LedgerCompletion;
}

/** Represents simulator run failure conditions. */
export type SimulatorRunFailure<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = AgentRosterAcquisitionError<Definitions> | LedgerFailure | NetworkFailure;

interface RunInput<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
> {
  readonly definitionId: Id;
  readonly eventServices: DefinitionEventServices<
    Id,
    CustomerSchema,
    CustomerClasses
  >;
  readonly roster: AgentRoster<Id, Definitions>;
  readonly program: Effect.Effect<A, E, R>;
  readonly options: SimulatorRunOptions;
}

type RunRequirements<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  R,
> =
  | AgentRosterRequirements<Definitions>
  | Exclude<
      R,
      | Context.Tag.Identifier<
          DefinitionEventServices<Id, CustomerSchema, CustomerClasses>["ledger"]
        >
      | Context.Tag.Identifier<
          DefinitionEventServices<Id, CustomerSchema, CustomerClasses>["events"]
        >
      | Context.Tag.Identifier<AgentRoster<Id, Definitions>["startedAgents"]>
      | Network
      | LinkController
      | Scope.Scope
    >
  | RouterProvider
  | LedgerStorage;

interface ProgramLayerInput<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly eventServices: DefinitionEventServices<
    Id,
    CustomerSchema,
    CustomerClasses
  >;
  readonly roster: AgentRoster<Id, Definitions>;
  readonly active: ActiveRunLedger<
    DefinitionEventServices<Id, CustomerSchema, CustomerClasses>["catalog"]
  >;
  readonly network: NetworkService;
  readonly links: LinkControllerService;
  readonly agents: StartedAgentHandles<Definitions>;
}

function makeProgramLayer<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(input: ProgramLayerInput<Id, CustomerSchema, CustomerClasses, Definitions>) {
  const customerWriter = input.active.writerFor(
    "program",
    input.eventServices.customerCatalog,
  );
  return Layer.mergeAll(
    input.eventServices.layer(input.active.ledger, customerWriter),
    Layer.succeed(Network, input.network),
    Layer.succeed(LinkController, input.links),
    Layer.succeed(input.roster.startedAgents, input.agents),
  );
}

interface KernelContext<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
> {
  readonly input: RunInput<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >;
  readonly active: ActiveRunLedger<
    DefinitionEventServices<Id, CustomerSchema, CustomerClasses>["catalog"]
  >;
  readonly runWriter: LedgerWriter<typeof runEvents>;
  readonly routerWriter: LedgerWriter<typeof routerEvents>;
  readonly runtimeWriter: LedgerWriter<typeof runtimeEvents>;
  readonly endpointWriter: LedgerWriter<typeof endpointEvents>;
  readonly linkWriter: LedgerWriter<typeof linkEvents>;
  readonly router: Ref.Ref<Router | undefined>;
}

function defaultProvenance<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(roster: AgentRoster<Id, Definitions>) {
  return {
    agents: Object.entries(roster.definitions).map(([name, runtime]) => ({
      name,
      runtime: runtime.name,
    })),
  };
}

function allocateRunLedger<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(input: RunInput<Id, CustomerSchema, CustomerClasses, Definitions, A, E, R>) {
  return makeRunLedger(input.eventServices.catalog, {
    definitionId: input.definitionId,
    provenance: input.options.provenance ?? defaultProvenance(input.roster),
    metadata: input.options.metadata ?? {},
  });
}

function makeContext<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(input: RunInput<Id, CustomerSchema, CustomerClasses, Definitions, A, E, R>) {
  return Effect.gen(function* () {
    const active = yield* allocateRunLedger(input);
    const router = yield* Ref.make<Router | undefined>(undefined);
    const runWriter = active.writerFor("kernel.run", runEvents);
    yield* runWriter.write({
      event: RunStarted.make({ definitionId: input.definitionId }),
    });
    return {
      input,
      active,
      runWriter,
      routerWriter: active.writerFor("kernel.router", routerEvents),
      runtimeWriter: active.writerFor("kernel.runtime", runtimeEvents),
      endpointWriter: active.writerFor("kernel.endpoint", endpointEvents),
      linkWriter: active.writerFor("kernel.link", linkEvents),
      router,
    };
  });
}

function executeProgram<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  context: KernelContext<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  return Effect.gen(function* () {
    const router = yield* acquireRouter(context.routerWriter);
    yield* Ref.set(context.router, router);
    const agents = yield* acquireRoster({
      router,
      roster: context.input.roster,
      writer: context.runtimeWriter,
    });
    const network = yield* makeNetworkService(router, context.endpointWriter);
    const links = yield* makeLinkController(context.linkWriter);
    const layer = makeProgramLayer({
      eventServices: context.input.eventServices,
      roster: context.input.roster,
      active: context.active,
      network,
      links,
      agents,
    });
    const exit = yield* context.input.program.pipe(
      Effect.provide(layer),
      Effect.exit,
      Effect.scoped,
    );
    yield* context.runWriter.write({ event: programEvent(exit) });
    return exit;
  });
}

function recordRouterStop<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  context: KernelContext<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  return Effect.gen(function* () {
    const router = yield* Ref.get(context.router);
    if (router !== undefined) {
      yield* recordStoppedRouter(router, context.routerWriter);
    }
  });
}

function finalizeRun<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  context: KernelContext<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
  execution: Exit.Exit<Exit.Exit<A, E>, unknown>,
) {
  return Effect.gen(function* () {
    const routerStop = yield* Effect.exit(recordRouterStop(context));
    const completion = yield* Effect.exit(context.active.complete());
    const failure = combinedFailure([execution, routerStop, completion]);
    if (
      failure !== undefined ||
      Exit.isFailure(execution) ||
      Exit.isFailure(completion)
    ) {
      return yield* failure === undefined
        ? Effect.dieMessage("a failed finalization Exit had no Cause")
        : Effect.failCause(failure);
    }
    return {
      exit: execution.value,
      ledger: context.active.ledger.ref,
      completion: completion.value,
    };
  });
}

function runContext<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  context: KernelContext<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  return Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.raceFirst(
        Effect.scoped(executeProgram(context)),
        context.active.failure,
      ),
    ).pipe(
      Effect.exit,
      Effect.flatMap((execution) => finalizeRun(context, execution)),
    ),
  );
}

function executeRun<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(input: RunInput<Id, CustomerSchema, CustomerClasses, Definitions, A, E, R>) {
  return Effect.scoped(
    makeContext(input).pipe(Effect.flatMap(runContext)),
  ).pipe(Effect.withSpan("Simulator.run"));
}

/**
 * Execute one definition against one mixed roster. Nested scopes stop
 * endpoints, runtimes, and the router before publishing ledger completion.
 * @param input Input value to process.
 * @returns The run society result.
 */
export function runSociety<
  const Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  input: RunInput<Id, CustomerSchema, CustomerClasses, Definitions, A, E, R>,
): Effect.Effect<
  SimulatorRunResult<A, E>,
  SimulatorRunFailure<Definitions>,
  RunRequirements<Id, CustomerSchema, CustomerClasses, Definitions, R>
> {
  return /* Safe because the surrounding invariant establishes this asserted shape. */ executeRun(
    input,
  ) as Effect.Effect<
    SimulatorRunResult<A, E>,
    SimulatorRunFailure<Definitions>,
    RunRequirements<Id, CustomerSchema, CustomerClasses, Definitions, R>
  >;
}
