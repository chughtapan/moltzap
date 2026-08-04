/**
 * A definition-bound keyed roster preserves its literal definition id, exact
 * handle names, gateways, and attachment errors without erasure.
 */

import { Effect, Schema } from "effect";
import { defineRuntime } from "./runtime.js";
import {
  type AgentRosterAcquisitionError,
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

const runtimeConfiguration = Schema.Struct({});
const configuration = {
  schema: runtimeConfiguration,
  value: {},
};

const alphaRuntime = defineRuntime<
  AlphaGateway,
  AlphaAcquisitionError,
  typeof runtimeConfiguration
>({
  name: "alpha",
  configuration,
});

const betaRuntime = defineRuntime<
  BetaGateway,
  BetaAcquisitionError,
  typeof runtimeConfiguration
>({
  name: "beta",
  configuration,
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
  ServiceSuccessIsExact,
];
