/**
 * A definition-bound keyed roster preserves its literal definition id, exact
 * handle names, and the union of heterogeneous runtime requirements. Those
 * types let the run Layer provide one exact Agents service without erasure.
 */

import { Context, Effect } from "effect";
import { RuntimeCompleted, defineRuntime } from "./runtime.js";
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
  acquire: () =>
    Effect.gen(function* () {
      yield* AlphaRequirement;
      return completed;
    }),
});

const betaRuntime = defineRuntime<never, BetaRequirement>({
  name: "beta",
  acquire: () =>
    Effect.gen(function* () {
      yield* BetaRequirement;
      return completed;
    }),
});

const roster = makeAgentRosterBuilder("acme.society/v1")({
  alice: alphaRuntime,
  bob: betaRuntime,
});

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
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

/** Representative roster program retained for compile-time inference checks. */
export const rosterCanaryProgram = Effect.gen(function* () {
  const handles = yield* roster.startedAgents;
  return handles.alice.name;
}).pipe(Effect.withSpan("rosterCanaryProgram"));

type ServiceSuccessIsExact = Expect<
  Equal<Effect.Effect.Success<typeof rosterCanaryProgram>, "alice">
>;

/** Compile-time assertions for exact roster inference. */
export type RosterCanaries = [
  DefinitionIdIsExact,
  HandleKeysAreExact,
  AliceNameIsExact,
  RequirementsAreCombined,
  ServiceSuccessIsExact,
];
