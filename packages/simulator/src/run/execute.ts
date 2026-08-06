/** @file Allocation, execution, and ordered finalization of one run. */
// safer-arch-ignore no-cross-domain-sibling-import: The run kernel is the composition root that wires ledger, network, agents, and cluster into one customer program.

import { Cause, Data, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
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
} from "../ledger/append.js";
import { LedgerCompletion, ledgerRef } from "../ledger/schema.js";
import type { LedgerStorageError } from "../ledger/storage.js";
import {
  LinkController,
  type LinkControllerService,
  LinkDriver,
  type LinkDriverService,
} from "../network/link.js";
import { Network, type NetworkService } from "../network/endpoint.js";
import type { Router } from "../network/router.js";
import type { NetworkError } from "../network/failure.js";
import {
  Cluster,
  type Society,
  type ClusterError,
} from "../cluster/cluster.js";
import type {
  AgentRoster,
  AgentRosterAcquisitionError,
  StartedAgents,
} from "../agents/roster.js";
import {
  runtimeConfigurationProjection,
  type AgentRuntimeLike,
} from "../agents/agent.js";
import { programEvent } from "./outcomes.js";
import { makeNetworkService } from "./endpoints.js";
import { makeLinkFabric } from "./link-fabric.js";
import { makeLinkController } from "./links.js";
import { acquireRoster } from "./acquire.js";
import { acquireRouter, recordStoppedRouter } from "./router.js";
import type { makeDefinitionEventServices } from "./events.js";

type CatalogSchema = Schema.Schema.AnyNoContext;

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
  readonly services: ProgramNetworkServices;
  readonly agents: StartedAgents<Definitions>;
}

/** Run-scoped network-facing services installed for the customer program. */
interface ProgramNetworkServices {
  readonly driver: LinkDriverService;
  readonly links: LinkControllerService;
  readonly network: NetworkService;
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
      endpointWriter: active.writerFor("kernel.endpoint", endpointEvents),
      linkWriter: active.writerFor("kernel.link", linkEvents),
      router,
    };
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
  const { context, router, session } = input;
  return Effect.gen(function* () {
    // The fabric shapes what this process can observe: the customer's own
    // controlled endpoints. A roster agent runs in its own container, so its
    // agent-to-agent traffic never crosses this stream and the fabric does not
    // register it. Link control over a containerized agent therefore fails
    // rather than silently passing traffic it claims to police.
    const fabric = yield* makeLinkFabric(context.linkWriter);
    const agents = yield* acquireRoster({
      router,
      roster: context.input.roster,
      session,
      writer: context.runtimeWriter,
    });
    const network = yield* makeNetworkService(
      router,
      context.endpointWriter,
      fabric.interceptor,
    );
    const links = yield* makeLinkController(context.linkWriter);
    const layer = makeProgramLayer({
      eventServices: context.input.eventServices,
      roster: context.input.roster,
      active: context.active,
      services: { driver: fabric.driver, links, network },
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

function appendFailure<Failure>(
  cause: Cause.Cause<Failure>,
  exit: Exit.Exit<unknown, Failure>,
): Cause.Cause<Failure> {
  return Exit.isFailure(exit) ? Cause.sequential(cause, exit.cause) : cause;
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
