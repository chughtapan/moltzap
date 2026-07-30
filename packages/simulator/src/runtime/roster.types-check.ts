/**
 * A definition-bound keyed roster preserves its literal definition id, exact
 * handle names, and the union of heterogeneous runtime requirements. Those
 * types let the run Layer provide one exact Agents service without erasure.
 */

import { Context, Effect, Schema } from "effect";
import { RuntimeCompleted, defineRuntime } from "./runtime.js";
import {
  type AgentRosterAcquisitionError,
  type AgentRosterRequirements,
  makeAgentRosterBuilder,
  type StartedAgents,
} from "./roster.js";

interface AlphaGateway {
  readonly runtime: "alpha";
}

interface BetaGateway {
  readonly runtime: "beta";
}

interface AlphaAcquisitionError {
  readonly alphaFailure: true;
}

interface BetaAcquisitionError {
  readonly betaFailure: true;
}

class AlphaRequirement extends Context.Tag(
  "@moltzap/simulator/test/AlphaRequirement",
)<
  AlphaRequirement,
  { readonly ready: Effect.Effect<void, AlphaAcquisitionError> }
>() {}

class BetaRequirement extends Context.Tag(
  "@moltzap/simulator/test/BetaRequirement",
)<
  BetaRequirement,
  { readonly ready: Effect.Effect<void, BetaAcquisitionError> }
>() {}

const alphaGateway: AlphaGateway = { runtime: "alpha" };
const betaGateway: BetaGateway = { runtime: "beta" };
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
      const requirement = yield* AlphaRequirement;
      yield* requirement.ready;
      return {
        gateway: alphaGateway,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }),
});

const betaRuntime = defineRuntime({
  name: "beta",
  configuration,
  acquire: () =>
    Effect.gen(function* () {
      const requirement = yield* BetaRequirement;
      yield* requirement.ready;
      return {
        gateway: betaGateway,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }),
});

const roster = makeAgentRosterBuilder("acme.society/v1")({
  alice: alphaRuntime,
  bob: betaRuntime,
});

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type Definitions = typeof roster.definitions;
type Agents = StartedAgents<Definitions>;

type DefinitionIdIsExact = Expect<
  Equal<typeof roster.definitionId, "acme.society/v1">
>;
type AgentKeysAreExact = Expect<Equal<keyof Agents, "alice" | "bob">>;
type AliceNameIsExact = Expect<
  Equal<Agents["alice"]["agent"]["name"], "alice">
>;
type AliceGatewayIsExact = Expect<
  Equal<Agents["alice"]["gateway"], AlphaGateway>
>;
type BobGatewayIsExact = Expect<Equal<Agents["bob"]["gateway"], BetaGateway>>;
type AcquisitionErrorsAreCombined = Expect<
  Equal<
    AgentRosterAcquisitionError<Definitions>,
    AlphaAcquisitionError | BetaAcquisitionError
  >
>;
type RequirementsAreCombined = Expect<
  Equal<
    AgentRosterRequirements<Definitions>,
    AlphaRequirement | BetaRequirement
  >
>;

/** Representative roster program retained for compile-time inference checks. */
export const rosterCanaryProgram = Effect.gen(function* () {
  const agents = yield* roster.startedAgents;
  return agents.alice.gateway;
}).pipe(Effect.withSpan("rosterCanaryProgram"));

type ServiceSuccessIsExact = Expect<
  Equal<Effect.Effect.Success<typeof rosterCanaryProgram>, AlphaGateway>
>;

/** Compile-time assertions for exact roster inference. */
export type RosterCanaries = [
  DefinitionIdIsExact,
  AgentKeysAreExact,
  AliceNameIsExact,
  AliceGatewayIsExact,
  BobGatewayIsExact,
  AcquisitionErrorsAreCombined,
  RequirementsAreCombined,
  ServiceSuccessIsExact,
];
