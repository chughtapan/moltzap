/** @file Allocation, execution, and ordered finalization of one run. */

import { Cause, Data, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import type { AgentRuntimeLike } from "../agents/agent.js";
import type { EventClass } from "../events/catalog.js";
import type { makeDefinitionEventServices } from "./events.js";
import {
  type AgentRoster,
  type AgentRosterAcquisitionError,
  runtimeConfigurationProjection,
  type StartedAgents,
} from "../agents/index.js";
import {
  Cluster,
  type ClusterError,
  type Society,
} from "../cluster/cluster.js";
import {
  AgentWorkspaceFileHarvested,
  linkEvents,
  routerEvents,
  RouterStarted,
  RouterStartFailed,
  RouterStopFailed,
  runEvents,
  RunStarted,
  runtimeEvents,
} from "../events/core.js";
import {
  type ActiveRunLedger,
  type LedgerWriter,
  makeRunLedger,
} from "../ledger/append.js";
import {
  LedgerCompletion,
  type LedgerFailure,
  ledgerRef,
  type LedgerStorageError,
} from "../ledger/index.js";
import {
  LinkController,
  type LinkControllerService,
  LinkDriver,
  type LinkDriverService,
  Network,
  type NetworkError,
  type NetworkService,
  type Router,
  RouterProvider,
} from "../network/index.js";
import { acquireRoster } from "./acquire.js";
import { makeNetworkService } from "./endpoints.js";
import { type LinkFabric, makeLinkFabric } from "./link-fabric.js";
import { makeLinkController } from "./links.js";
import { nonEmptyCause, programEvent } from "./outcomes.js";
import {
  makeRouterFaultProxy,
  type RouterFaultProxy,
} from "./router-fault-proxy.js";

// safer-arch-ignore no-cross-domain-sibling-import: The run kernel wires ledger, Router lifecycle, fault control, agents, and cluster into one customer program.

type CatalogSchema = Schema.Schema.AnyNoContext;

/**
 * Agents whose workspaces are read at once after the customer program ends.
 * Every file is one exec session against the cluster API, so the bound keeps
 * a hundred-agent cohort from opening a hundred sessions at once while a
 * small cohort still finishes in one round.
 */
const HARVEST_CONCURRENCY = 8;

type DefinitionEventServices<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
> = ReturnType<
  typeof makeDefinitionEventServices<Id, CustomerSchema, CustomerClasses>
>;

/** Physical receipt for a ledger whose completion marker is durable. */
export class CompletedLedgerReceipt extends Schema.TaggedClass<CompletedLedgerReceipt>()(
  "CompletedLedgerReceipt",
  {
    ledger: ledgerRef,
    completion: LedgerCompletion,
  },
) {}

/** Physical receipt retained when ledger completion could not be published. */
export class IncompleteLedgerReceipt extends Schema.TaggedClass<IncompleteLedgerReceipt>()(
  "IncompleteLedgerReceipt",
  {
    ledger: ledgerRef,
  },
) {}

/** Schema for the complete physical ledger-receipt universe. */
// eslint-disable-next-line @typescript-eslint/naming-convention, agent-code-guard/no-exported-brand-constructor -- persisted evaluation reports compose this closed physical-receipt union at their Schema boundary.
export const LedgerReceipt = Schema.Union(
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
);
/** Decoded physical ledger receipt. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- the value is the runtime Schema and the type is its decoded result.
export type LedgerReceipt = typeof LedgerReceipt.Type;

/** Customer-program completion plus its complete durable evidence. */
export class ProgramFinished<A, E> extends Data.TaggedClass("ProgramFinished")<{
  readonly exit: Exit.Exit<A, E>;
  readonly receipt: CompletedLedgerReceipt;
}> {}

/** Post-allocation cluster error plus all durable evidence retained. */
export class ClusterLost<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> extends Data.TaggedClass("ClusterLost")<{
  readonly cause: Cause.Cause<SimulatorRunFailure<Definitions>>;
  readonly receipt: LedgerReceipt;
}> {}

/** Closed result of every run whose ledger allocation succeeded. */
export type SimulatorRunOutcome<
  A,
  E,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> = ProgramFinished<A, E> | ClusterLost<Definitions>;

/** Represents simulator run failure conditions. */
export type SimulatorRunFailure<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> =
  | AgentRosterAcquisitionError<Definitions>
  | ClusterError
  | LedgerFailure
  | NetworkError;

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
}

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
  readonly services: ProgramFaultServices;
  readonly agents: StartedAgents<Definitions>;
}

/** Run-scoped fault-control services installed for the customer program. */
interface ProgramFaultServices {
  readonly driver: LinkDriverService;
  readonly links: LinkControllerService;
  readonly network: NetworkService;
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
  readonly linkWriter: LedgerWriter<typeof linkEvents>;
  readonly router: Ref.Ref<Option.Option<Router>>;
}

interface SocietyExecutionInput<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
> {
  readonly context: KernelContext<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >;
  readonly router: Router;
  readonly session: Society<Definitions>;
}

interface PreparedSocietyExecutionInput<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
> extends SocietyExecutionInput<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  > {
  readonly fabric: LinkFabric;
  readonly proxy: RouterFaultProxy;
}

/**
 * Execute one definition against one mixed roster. Nested scopes stop the
 * cluster and Router before publishing ledger completion.
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
  SimulatorRunOutcome<A, E, Definitions>,
  LedgerStorageError,
  Effect.Effect.Context<
    ReturnType<
      typeof executeRun<
        Id,
        CustomerSchema,
        CustomerClasses,
        Definitions,
        A,
        E,
        R
      >
    >
  >
> {
  return executeRun(input);
}

/**
 * Ledger allocation and context construction form one ownership handoff.
 * Interruptibility resumes only after the kernel can finalize that ledger.
 * @param input Definition-bound run description and customer program.
 * @returns The scoped run Effect.
 */
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
    Effect.uninterruptibleMask((restore) =>
      allocateRunLedger(input).pipe(
        Effect.flatMap((active) => makeContext(input, active)),
        Effect.flatMap((context) => runContext(context, restore)),
      ),
    ),
  ).pipe(Effect.withSpan("Simulator.run"));
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
    provenance: {
      agents: Object.entries(input.roster.definitions).map(
        ([name, runtime]) => ({
          name,
          runtime: runtime.name,
          configuration: runtimeConfigurationProjection(runtime),
        }),
      ),
    },
    metadata: {},
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
>(
  input: RunInput<Id, CustomerSchema, CustomerClasses, Definitions, A, E, R>,
  active: ActiveRunLedger<
    DefinitionEventServices<Id, CustomerSchema, CustomerClasses>["catalog"]
  >,
) {
  return Effect.gen(function* () {
    const router = yield* Ref.make(Option.none<Router>());
    return {
      input,
      active,
      runWriter: active.writerFor("kernel.run", runEvents),
      routerWriter: active.writerFor("kernel.router", routerEvents),
      runtimeWriter: active.writerFor("kernel.runtime", runtimeEvents),
      linkWriter: active.writerFor("kernel.link", linkEvents),
      router,
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
  restore: <RestoredA, RestoredE, RestoredR>(
    effect: Effect.Effect<RestoredA, RestoredE, RestoredR>,
  ) => Effect.Effect<RestoredA, RestoredE, RestoredR>,
) {
  return restore(
    Effect.raceFirst(
      Effect.scoped(executeProgram(context)),
      context.active.failure,
    ),
  ).pipe(
    Effect.exit,
    Effect.flatMap((execution) =>
      finalizeRun(context, execution).pipe(
        Effect.flatMap((outcome) => preserveCancellation(execution, outcome)),
      ),
    ),
  );
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
    yield* context.runWriter.write({
      event: RunStarted.make({ definitionId: context.input.definitionId }),
    });
    const router = yield* acquireRouter(context.routerWriter, context.router);
    const platform = yield* Cluster;
    const session = yield* platform.prepare(context.input.roster);
    return yield* Effect.raceFirst(
      executeSociety({ context, router, session }),
      session.failure,
    );
  });
}

function executeSociety<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  input: SocietyExecutionInput<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  const { router, session } = input;
  return Effect.gen(function* () {
    const fabric = yield* makeLinkFabric();
    const proxy = yield* makeRouterFaultProxy({
      upstreamRouterOrigin: router.address,
      listener: session.routerFaultProxy.listener,
      fabric,
    });
    return yield* Effect.raceFirst(
      runSocietyProgram({ ...input, fabric, proxy }),
      proxy.failure,
    );
  });
}

/**
 * Run the customer program against the started society and record what it
 * left. A program that ended in interruption alone is a run being cancelled,
 * so workspaces are not read then: the read would hold the cancellation on
 * the cluster API. A cause carrying a failure as well is still harvested,
 * because that run has something to explain.
 */
function runSocietyProgram<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  input: PreparedSocietyExecutionInput<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  const { context, session } = input;
  return Effect.gen(function* () {
    const { layer, agents } = yield* makeSocietyProgramLayer(input);
    const exit = yield* context.input.program.pipe(
      Effect.provide(layer),
      Effect.exit,
      Effect.scoped,
    );
    yield* context.runWriter.write({ event: programEvent(exit) });
    if (Exit.isSuccess(exit) || !Cause.isInterruptedOnly(exit.cause)) {
      yield* harvestWorkspaces({
        roster: context.input.roster,
        agents,
        session,
        writer: context.runtimeWriter,
      });
    }
    return exit;
  });
}

interface HarvestWorkspacesInput<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
> {
  readonly roster: AgentRoster<Id, Definitions>;
  readonly agents: StartedAgents<Definitions>;
  readonly session: Society<Definitions>;
  readonly writer: LedgerWriter<typeof runtimeEvents>;
}

/**
 * Record every declared workspace file of every agent while the society is
 * still up. Agents are read concurrently, so records land in completion
 * order; each agent's own files keep their declaration order. A file that
 * cannot be read is a typed outcome and never ends the run. Completion means
 * every record is durable.
 */
function harvestWorkspaces<
  Id extends string,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(input: HarvestWorkspacesInput<Id, Definitions>) {
  return Effect.forEach(
    input.roster.validatedDefinitions,
    (entry) =>
      input.session.harvestWorkspace(entry.name).pipe(
        Effect.flatMap((files) =>
          Effect.forEach(
            files,
            (file) =>
              input.writer.write({
                event: AgentWorkspaceFileHarvested.make({
                  agentName: entry.agentName,
                  agentId: input.agents[entry.name].agent.id,
                  runtime: entry.runtime.name,
                  relativePath: file.relativePath,
                  outcome: file.outcome,
                }),
              }),
            { concurrency: 1, discard: true },
          ),
        ),
      ),
    { concurrency: HARVEST_CONCURRENCY, discard: true },
  ).pipe(Effect.withSpan("Simulator.harvestWorkspaces"));
}

function makeSocietyProgramLayer<
  Id extends string,
  CustomerSchema extends CatalogSchema,
  CustomerClasses extends EventClass,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  input: PreparedSocietyExecutionInput<
    Id,
    CustomerSchema,
    CustomerClasses,
    Definitions,
    A,
    E,
    R
  >,
) {
  const { context, fabric, proxy, session } = input;
  return Effect.gen(function* () {
    const agents = yield* acquireRoster({
      roster: context.input.roster,
      session,
      writer: context.runtimeWriter,
    });
    yield* attachAgents(agents, fabric);
    const network = yield* makeNetworkService({
      acquireEndpoint: session.acquireEndpoint,
      routerOrigin: proxy.localRouterOrigin,
      interceptor: fabric.interceptor,
    });
    const links = yield* makeLinkController(context.linkWriter);
    const layer = makeProgramLayer({
      eventServices: context.input.eventServices,
      roster: context.input.roster,
      active: context.active,
      services: { driver: fabric.driver, links, network },
      agents,
    });
    return { layer, agents };
  });
}

function attachAgents<
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
>(agents: StartedAgents<Definitions>, fabric: LinkFabric) {
  return Effect.forEach(
    Object.values(agents),
    ({ agent }) => fabric.interceptor.attach(agent.id),
    { concurrency: 1, discard: true },
  );
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
    Layer.succeed(Network, input.services.network),
    Layer.succeed(LinkController, input.services.links),
    Layer.succeed(LinkDriver, input.services.driver),
    Layer.succeed(input.roster.startedAgents, input.agents),
  );
}

function acquireRouter(
  writer: LedgerWriter<typeof routerEvents>,
  routerRef: Ref.Ref<Option.Option<Router>>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const provider = yield* RouterProvider;
      const attempted = yield* Effect.exit(restore(provider.acquire));
      if (Exit.isFailure(attempted)) {
        if (Cause.isInterruptedOnly(attempted.cause)) {
          return yield* Effect.failCause(attempted.cause);
        }
        const recorded = yield* Effect.exit(
          restore(
            writer.write({
              event: RouterStartFailed.make({
                cause: nonEmptyCause(attempted.cause),
              }),
            }),
          ),
        );
        return yield* Effect.failCause(
          Exit.isFailure(recorded)
            ? Cause.sequential(attempted.cause, recorded.cause)
            : attempted.cause,
        );
      }
      yield* Ref.set(routerRef, Option.some(attempted.value));
      yield* restore(
        writer.write({
          event: RouterStarted.make({
            routerUrl: attempted.value.address,
          }),
        }),
      );
      return attempted.value;
    }),
  ).pipe(Effect.withSpan("Simulator.acquireRouter"));
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- the generic signature states the exact definition-bound outcome contract while the body keeps ordered stop/completion handling together.
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
  execution: Exit.Exit<Exit.Exit<A, E>, SimulatorRunFailure<Definitions>>,
) {
  return Effect.gen(function* () {
    const routerStop = yield* Effect.exit(
      recordRouterStop(context.router, context.routerWriter),
    );
    const completion = yield* Effect.exit(context.active.complete());
    const receipt = Exit.isSuccess(completion)
      ? CompletedLedgerReceipt.make({
          ledger: context.active.ledger.ref,
          completion: completion.value,
        })
      : IncompleteLedgerReceipt.make({
          ledger: context.active.ledger.ref,
        });
    if (Exit.isFailure(execution)) {
      return new ClusterLost<Definitions>({
        cause: appendFailure(
          appendFailure(execution.cause, routerStop),
          completion,
        ),
        receipt,
      });
    }
    if (Exit.isFailure(routerStop)) {
      return new ClusterLost<Definitions>({
        cause: appendFailure(routerStop.cause, completion),
        receipt,
      });
    }
    if (Exit.isFailure(completion)) {
      return new ClusterLost<Definitions>({
        cause: completion.cause,
        receipt,
      });
    }
    return new ProgramFinished({
      exit: execution.value,
      receipt: CompletedLedgerReceipt.make({
        ledger: context.active.ledger.ref,
        completion: completion.value,
      }),
    });
  });
}

function recordRouterStop(
  routerRef: Ref.Ref<Option.Option<Router>>,
  writer: LedgerWriter<typeof routerEvents>,
) {
  return Ref.get(routerRef).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (router) => recordStoppedRouter(router, writer),
      }),
    ),
  );
}

function recordStoppedRouter(
  router: Router,
  writer: LedgerWriter<typeof routerEvents>,
) {
  return Effect.exit(router.stopped).pipe(
    Effect.flatMap((stopped) => {
      if (Exit.isSuccess(stopped)) {
        return Effect.void;
      }
      return Effect.exit(
        writer.write({
          event: RouterStopFailed.make({
            cause: nonEmptyCause(stopped.cause),
          }),
        }),
      ).pipe(
        Effect.flatMap((recorded) =>
          Effect.failCause(
            Exit.isFailure(recorded)
              ? Cause.sequential(stopped.cause, recorded.cause)
              : stopped.cause,
          ),
        ),
      );
    }),
  );
}

function appendFailure<Failure>(
  cause: Cause.Cause<Failure>,
  exit: Exit.Exit<unknown, Failure>,
): Cause.Cause<Failure> {
  return Exit.isFailure(exit) ? Cause.sequential(cause, exit.cause) : cause;
}

/**
 * Cancellation remains an Effect interrupt after durable finalization. Run
 * outcomes describe completed execution paths, not control-plane cancellation.
 * @param execution Complete exit from the interruptible execution region.
 * @param outcome Durable run outcome produced after finalization.
 * @returns The outcome unless caller cancellation must be restored.
 */
function preserveCancellation<
  A,
  E,
  Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  Failure,
>(
  execution: Exit.Exit<unknown, Failure>,
  outcome: SimulatorRunOutcome<A, E, Definitions>,
): Effect.Effect<SimulatorRunOutcome<A, E, Definitions>> {
  if (Exit.isSuccess(execution) || !Cause.isInterrupted(execution.cause)) {
    return Effect.succeed(outcome);
  }
  const interruptions = collectInterruptions(execution.cause);
  return interruptions === undefined
    ? Effect.interrupt
    : Effect.failCause(interruptions);
}

function collectInterruptions(
  cause: Cause.Cause<unknown>,
): Cause.Cause<never> | undefined {
  let interruptions: Cause.Cause<never> | undefined;
  for (const interruptor of Cause.interruptors(cause)) {
    const interruption = Cause.interrupt(interruptor);
    interruptions =
      interruptions === undefined
        ? interruption
        : Cause.parallel(interruptions, interruption);
  }
  return interruptions;
}
