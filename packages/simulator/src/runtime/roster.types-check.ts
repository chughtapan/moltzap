/**
 * A definition-bound keyed roster preserves its literal definition id, exact
 * handle names, and the union of heterogeneous runtime requirements. Those
 * types let the run Layer provide one exact Agents service without erasure.
 */

import { Context, Effect } from "effect";
import {
  RuntimeCompleted,
  type AgentRuntimeInput,
  defineRuntime,
} from "./runtime.js";
import {
  type AgentRosterRequirements,
  makeAgentRosterBuilder,
  type StartedAgentHandles,
} from "./roster.js";

class AlphaRequirement extends Context.Tag(
  "@moltzap/simulator/test/AlphaRequirement",
)<AlphaRequirement, { readonly alpha: true }>() {}

class BetaRequirement extends Context.Tag(
  "@moltzap/simulator/test/BetaRequirement",
)<BetaRequirement, { readonly beta: true }>() {}

const completed = {
  termination: Effect.succeed(RuntimeCompleted.make({})),
};

const alphaRuntime = defineRuntime<never, AlphaRequirement>({
  name: "alpha",
  acquire: <Name extends string>(_input: AgentRuntimeInput<Name>) =>
    Effect.gen(function* () {
      yield* AlphaRequirement;
      return completed;
    }),
});

const betaRuntime = defineRuntime<never, BetaRequirement>({
  name: "beta",
  acquire: <Name extends string>(_input: AgentRuntimeInput<Name>) =>
    Effect.gen(function* () {
      yield* BetaRequirement;
      return completed;
    }),
});

const roster = makeAgentRosterBuilder("acme.society/v1")({
  alice: alphaRuntime,
  bob: betaRuntime,
});

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type Definitions = typeof roster.definitions;
type Handles = StartedAgentHandles<Definitions>;

type DefinitionIdIsExact = Expect<
  Equal<typeof roster.definitionId, "acme.society/v1">
>;
type HandleKeysAreExact = Expect<Equal<keyof Handles, "alice" | "bob">>;
type AliceNameIsExact = Expect<Equal<Handles["alice"]["name"], "alice">>;
type RequirementsAreCombined = Expect<
  Equal<
    AgentRosterRequirements<Definitions>,
    AlphaRequirement | BetaRequirement
  >
>;

const handlesProgram = Effect.gen(function* () {
  const handles = yield* roster.Agents;
  return handles.alice.name;
});

type ServiceSuccessIsExact = Expect<
  Equal<Effect.Effect.Success<typeof handlesProgram>, "alice">
>;

type _Canaries =
  | DefinitionIdIsExact
  | HandleKeysAreExact
  | AliceNameIsExact
  | RequirementsAreCombined
  | ServiceSuccessIsExact;
