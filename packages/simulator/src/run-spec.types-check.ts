/**
 * A RunSpec preserves exact heterogeneous gateways and contains customer
 * completion inside ProgramFinished. Its infrastructure Layer supplies every
 * runtime and kernel dependency, removes even customer-used extra outputs,
 * and leaves only the Layer input plus customer-owned requirements outside.
 */

import {
  Context,
  Data,
  Effect,
  type Exit,
  Layer,
  Schema,
  type Scope,
  type Stream,
  type Tracer,
} from "effect";
import { EventCatalog } from "./events/catalog.js";
import type { LedgerFailure } from "./ledger/live.js";
import { LedgerStorage, type LedgerStorageError } from "./ledger/storage.js";
import { RouterProvider } from "./network/router.js";
import { Run, RunSpec, simulator } from "./definition.js";
import type { ProgramFinished, SimulatorRunFailure } from "./kernel/run.js";
import type { SimulatorInfrastructureFailure } from "./platform/failure.js";
import { RuntimeCompleted, defineRuntime } from "./runtime/runtime.js";

interface AlphaGateway {
  readonly runtime: "alpha";
  readonly submit: (input: string) => Effect.Effect<"alpha-accepted">;
}

interface BetaGateway {
  readonly runtime: "beta";
  readonly inspect: Effect.Effect<"beta-ready">;
}

class AlphaRuntimeRequirement extends Context.Tag(
  "@moltzap/simulator/test/RunSpecAlphaRuntimeRequirement",
)<AlphaRuntimeRequirement, { readonly gateway: AlphaGateway }>() {}

class BetaRuntimeRequirement extends Context.Tag(
  "@moltzap/simulator/test/RunSpecBetaRuntimeRequirement",
)<BetaRuntimeRequirement, { readonly gateway: BetaGateway }>() {}

class InfrastructureInput extends Context.Tag(
  "@moltzap/simulator/test/RunSpecInfrastructureInput",
)<InfrastructureInput, { readonly profile: "local" | "gke" }>() {}

class InfrastructureExtra extends Context.Tag(
  "@moltzap/simulator/test/RunSpecInfrastructureExtra",
)<InfrastructureExtra, { readonly marker: "layer-output" }>() {}

class CustomerRequirement extends Context.Tag(
  "@moltzap/simulator/test/RunSpecCustomerRequirement",
)<
  CustomerRequirement,
  { readonly check: Effect.Effect<void, CustomerFailure> }
>() {}

class CustomerFailure extends Data.TaggedError("CustomerFailure")<{
  readonly detail: string;
}> {}

class InfrastructureUnavailable extends Data.TaggedError(
  "InfrastructureUnavailable",
)<{
  readonly detail: string;
}> {}

class Observation extends Schema.TaggedClass<Observation>()(
  "acme.run-spec-observation/v1",
  {
    detail: Schema.String,
  },
) {}

const runtimeConfiguration = Schema.Struct({});
const configuration = {
  schema: runtimeConfiguration,
  value: {},
};

const alphaRuntime = defineRuntime({
  name: "alpha",
  configuration,
  acquire: () =>
    Effect.gen(function* () {
      const requirement = yield* AlphaRuntimeRequirement;
      return {
        gateway: requirement.gateway,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }).pipe(Effect.withSpan("runSpecAlphaRuntime")),
});

const betaRuntime = defineRuntime({
  name: "beta",
  configuration,
  acquire: () =>
    Effect.gen(function* () {
      const requirement = yield* BetaRuntimeRequirement;
      return {
        gateway: requirement.gateway,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }).pipe(Effect.withSpan("runSpecBetaRuntime")),
});

const unavailableInfrastructure = Effect.gen(function* () {
  yield* InfrastructureInput;
  return yield* Effect.fail(
    new InfrastructureUnavailable({ detail: "compile-time canary" }),
  );
});

const infrastructure = Layer.mergeAll(
  Layer.effect(LedgerStorage, unavailableInfrastructure),
  Layer.effect(RouterProvider, unavailableInfrastructure),
  Layer.effect(AlphaRuntimeRequirement, unavailableInfrastructure),
  Layer.effect(BetaRuntimeRequirement, unavailableInfrastructure),
  Layer.effect(InfrastructureExtra, unavailableInfrastructure),
);

const observations = EventCatalog.make(Observation);

/** Representative RunSpec retained for compile-time inference checks. */
export const runSpecCanary = RunSpec.define({
  id: "acme.run-spec-canary/v1",
  events: [observations],
  agents: {
    alice: alphaRuntime,
    bob: betaRuntime,
  },
  infrastructure,
  execute: ({ agents, events }) =>
    Effect.gen(function* () {
      const customer = yield* CustomerRequirement;
      const extra = yield* InfrastructureExtra;
      yield* customer.check;
      yield* events
        .emit(Observation.make({ detail: extra.marker }))
        .pipe(Effect.ignore);
      return [
        agents.alice.gateway.runtime,
        agents.bob.gateway.runtime,
        extra.marker,
      ] as const;
    }).pipe(Effect.withSpan("runSpecCanary")),
});

/** Representative root execution retained for compile-time contract checks. */
export const runSpecCanaryExecution = Run.execute(runSpecCanary);

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;
type ProgramTypes<Outcome> =
  Outcome extends ProgramFinished<infer Success, infer Failure>
    ? readonly [Success, Failure]
    : never;

type ExecuteContext = Parameters<typeof runSpecCanary.execute>[0];
type Agents = ExecuteContext["agents"];
type ExecutionRequirements = Effect.Effect.Context<
  typeof runSpecCanaryExecution
>;

type AgentKeysAreExact = Expect<Equal<keyof Agents, "alice" | "bob">>;
type AliceNameIsExact = Expect<
  Equal<Agents["alice"]["agent"]["name"], "alice">
>;
type AliceGatewayIsExact = Expect<
  Equal<Agents["alice"]["gateway"], AlphaGateway>
>;
type BobGatewayIsExact = Expect<Equal<Agents["bob"]["gateway"], BetaGateway>>;
type CustomerExitIsRetained = Expect<
  Equal<
    ProgramTypes<Effect.Effect.Success<typeof runSpecCanaryExecution>>,
    readonly [readonly ["alpha", "beta", "layer-output"], CustomerFailure]
  >
>;
type OuterErrorsAreInfrastructureOnly = Expect<
  Equal<
    Effect.Effect.Error<typeof runSpecCanaryExecution>,
    InfrastructureUnavailable | LedgerStorageError
  >
>;
type ExternalRequirementsAreExact = Expect<
  Equal<ExecutionRequirements, InfrastructureInput | CustomerRequirement>
>;
type LayerExtraOutputIsRemoved = Expect<
  Equal<Extract<ExecutionRequirements, InfrastructureExtra>, never>
>;
type RuntimeRequirementsAreRemoved = Expect<
  Equal<
    Extract<
      ExecutionRequirements,
      AlphaRuntimeRequirement | BetaRuntimeRequirement
    >,
    never
  >
>;
type KernelStorageAndRouterAreRemoved = Expect<
  Equal<Extract<ExecutionRequirements, LedgerStorage | RouterProvider>, never>
>;
type ScopeDoesNotLeak = Expect<
  Equal<Extract<ExecutionRequirements, Scope.Scope>, never>
>;
type ParentSpanDoesNotLeak = Expect<
  Equal<Extract<ExecutionRequirements, Tracer.ParentSpan>, never>
>;
type LiveRecordsRetainInfrastructureFailure = Expect<
  Equal<Stream.Stream.Error<ExecuteContext["ledger"]["records"]>, LedgerFailure>
>;

/** Matching completed-ledger reader retained for stream error checks. */
export const completedRunSpecCanaryReader = simulator.define(
  "acme.run-spec-canary/v1",
  observations,
);
type OpenedLedger = Effect.Effect.Success<
  ReturnType<typeof completedRunSpecCanaryReader.openLedger>
>;
type CompletedRecordsCannotFail = Expect<
  Equal<Stream.Stream.Error<OpenedLedger["records"]>, never>
>;
type FinishedOutcome = Extract<
  Effect.Effect.Success<typeof runSpecCanaryExecution>,
  { readonly _tag: "ProgramFinished" }
>;
type ProgramFinishedExitIsExact = Expect<
  Equal<
    FinishedOutcome["exit"],
    Exit.Exit<readonly ["alpha", "beta", "layer-output"], CustomerFailure>
  >
>;
type InfrastructureFailureUsesPublicShape = Expect<
  Equal<
    Extract<
      SimulatorRunFailure<typeof runSpecCanary.agents>,
      { readonly _tag: "SimulatorInfrastructureFailure" }
    >,
    SimulatorInfrastructureFailure
  >
>;

/** Compile-time assertions for the additive RunSpec execution surface. */
export type RunSpecCanaries = [
  AgentKeysAreExact,
  AliceNameIsExact,
  AliceGatewayIsExact,
  BobGatewayIsExact,
  CustomerExitIsRetained,
  OuterErrorsAreInfrastructureOnly,
  ExternalRequirementsAreExact,
  LayerExtraOutputIsRemoved,
  RuntimeRequirementsAreRemoved,
  KernelStorageAndRouterAreRemoved,
  ScopeDoesNotLeak,
  ParentSpanDoesNotLeak,
  LiveRecordsRetainInfrastructureFailure,
  CompletedRecordsCannotFail,
  ProgramFinishedExitIsExact,
  InfrastructureFailureUsesPublicShape,
];
