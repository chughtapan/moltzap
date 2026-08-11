/**
 * A RunSpec preserves exact heterogeneous gateways and contains customer
 * completion inside ProgramFinished. Its cluster Layer supplies the
 * kernel and cluster, removes customer-used extra outputs, and leaves only
 * the Layer input plus customer-owned requirements outside.
 */

import {
  Context,
  Data,
  Effect,
  type Exit,
  Layer,
  Schema,
  type Stream,
} from "effect";
import { EventCatalog } from "./events/catalog.js";
import { coreEvents } from "./events/core.js";
import type { LedgerFailure } from "./ledger/append.js";
import type { LedgerRef } from "./ledger/schema.js";
import { openLedger } from "./ledger/read.js";
import { LedgerStorage, type LedgerStorageError } from "./ledger/storage.js";
import { RouterProvider } from "./network/router.js";
import { Run, RunSpec } from "./definition.js";
import type { ProgramFinished, SimulatorRunFailure } from "./run/execute.js";
import { type ClusterError, Cluster } from "./cluster/cluster.js";
import { defineRuntime } from "./agents/agent.js";

interface AlphaGateway {
  readonly runtime: "alpha";
  readonly submit: (input: string) => Effect.Effect<"alpha-accepted">;
}

interface BetaGateway {
  readonly runtime: "beta";
  readonly inspect: Effect.Effect<"beta-ready">;
}

class ClusterInput extends Context.Tag(
  "@moltzap/simulator/test/RunSpecClusterInput",
)<ClusterInput, { readonly profile: "local" | "gke" }>() {}

class ClusterExtra extends Context.Tag(
  "@moltzap/simulator/test/RunSpecClusterExtra",
)<ClusterExtra, { readonly marker: "layer-output" }>() {}

class CustomerRequirement extends Context.Tag(
  "@moltzap/simulator/test/RunSpecCustomerRequirement",
)<
  CustomerRequirement,
  { readonly check: Effect.Effect<void, CustomerFailure> }
>() {}

class CustomerFailure extends Data.TaggedError("CustomerFailure")<{
  readonly detail: string;
}> {}

class ClusterUnavailable extends Data.TaggedError("ClusterUnavailable")<{
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

const alphaRuntime = defineRuntime<
  AlphaGateway,
  never,
  typeof runtimeConfiguration
>({
  name: "alpha",
  configuration,
});

const betaRuntime = defineRuntime<
  BetaGateway,
  never,
  typeof runtimeConfiguration
>({
  name: "beta",
  configuration,
});

const unavailableCluster = Effect.gen(function* () {
  yield* ClusterInput;
  return yield* Effect.fail(
    new ClusterUnavailable({ detail: "compile-time canary" }),
  );
});

const cluster = Layer.mergeAll(
  Layer.effect(LedgerStorage, unavailableCluster),
  Layer.effect(RouterProvider, unavailableCluster),
  Layer.effect(Cluster, unavailableCluster),
  Layer.effect(ClusterExtra, unavailableCluster),
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
  cluster,
  execute: ({ agents, events }) =>
    Effect.gen(function* () {
      const customer = yield* CustomerRequirement;
      const extra = yield* ClusterExtra;
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
type OuterErrorsAreClusterOnly = Expect<
  Equal<
    Effect.Effect.Error<typeof runSpecCanaryExecution>,
    ClusterUnavailable | LedgerStorageError
  >
>;
// Exhaustive: the cluster Layer's extra output, the kernel services it
// supplies, Scope, and the parent span are all absent from this exact union.
type ExternalRequirementsAreExact = Expect<
  Equal<ExecutionRequirements, ClusterInput | CustomerRequirement>
>;
type LiveRecordsRetainClusterError = Expect<
  Equal<Stream.Stream.Error<ExecuteContext["ledger"]["records"]>, LedgerFailure>
>;

/**
 * Matching completed-ledger reader retained for stream error checks.
 * @param ref Durable ledger identity used by the canary.
 * @returns The matching completed-ledger reader Effect.
 */
export const completedRunSpecCanaryReader = (ref: LedgerRef) =>
  openLedger(
    EventCatalog.merge(coreEvents, observations),
    ref,
    "acme.run-spec-canary/v1",
  );
type OpenedLedger = Effect.Effect.Success<
  ReturnType<typeof completedRunSpecCanaryReader>
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
type ClusterErrorUsesPublicShape = Expect<
  Equal<
    Extract<
      SimulatorRunFailure<typeof runSpecCanary.agents>,
      { readonly _tag: "ClusterError" }
    >,
    ClusterError
  >
>;

/** Compile-time assertions for the additive RunSpec execution surface. */
export type RunSpecCanaries = [
  AgentKeysAreExact,
  AliceNameIsExact,
  AliceGatewayIsExact,
  BobGatewayIsExact,
  CustomerExitIsRetained,
  OuterErrorsAreClusterOnly,
  ExternalRequirementsAreExact,
  LiveRecordsRetainClusterError,
  CompletedRecordsCannotFail,
  ProgramFinishedExitIsExact,
  ClusterErrorUsesPublicShape,
];
