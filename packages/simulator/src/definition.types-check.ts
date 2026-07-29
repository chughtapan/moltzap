/**
 * A definition-bound run removes only the services it installs. Platform,
 * runtime, and customer requirements remain explicit, while endpoint
 * acquisition does not leak Scope into experiment code. Run options describe
 * the run without altering event truth. Opening validates the complete ledger
 * before returning, so its in-memory streams cannot fail.
 */

import {
  Context,
  Data,
  Effect,
  type Exit,
  Schema,
  type Stream,
} from "effect";
import type { MessageParts } from "@moltzap/protocol/message";
import {
  LinkController,
  type LinkDriver,
  Network,
  type RouterProvider,
} from "./network.js";
import { RuntimeCompleted, defineRuntime } from "./runtime/runtime.js";
import type { LedgerStorage } from "./ledger/storage.js";
import { simulator } from "./definition.js";
import type { ProgramFinished, SimulatorRunOptions } from "./kernel/run.js";

class RuntimeRequirement extends Context.Tag(
  "@moltzap/simulator/test/RuntimeRequirement",
)<RuntimeRequirement, { readonly runtime: true }>() {}

class ProgramRequirement extends Context.Tag(
  "@moltzap/simulator/test/ProgramRequirement",
)<ProgramRequirement, { readonly program: true }>() {}

class RuntimeUnavailable extends Data.TaggedError("RuntimeUnavailable")<{
  readonly detail: string;
}> {}

const RuntimeConfiguration = Schema.Struct({});
const runtime = defineRuntime<
  RuntimeUnavailable,
  RuntimeRequirement,
  typeof RuntimeConfiguration
>({
  name: "type-canary",
  configuration: {
    schema: RuntimeConfiguration,
    value: {},
  },
  acquire: () =>
    Effect.gen(function* () {
      yield* RuntimeRequirement;
      return {
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }),
});

const society = simulator.define("acme.type-canary/v1");
const roster = society.agents({
  alice: runtime,
});

const program = Effect.gen(function* () {
  const agents = yield* roster.startedAgents;
  yield* society.ledger;
  yield* society.events;
  const network = yield* Network;
  const links = yield* LinkController;
  yield* ProgramRequirement;
  const probe = yield* network.endpoint("probe");
  const conversation = yield* probe.open(agents.alice);
  yield* conversation.send("hello");
  yield* links.disable(agents.alice, probe.participant);
  return [agents.alice.name, probe.participant.name] as const;
});

/** Representative definition run retained for compile-time contract checks. */
export const definitionCanaryRun = society.run(roster, program);

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;
type ExitSuccess<Outcome> =
  Outcome extends Exit.Exit<infer Success, infer _Failure> ? Success : never;
type ProgramExit<Outcome> =
  Outcome extends ProgramFinished<infer Success, infer Failure>
    ? Exit.Exit<Success, Failure>
    : never;

type RunRequirementsAreExact = Expect<
  Equal<
    Effect.Effect.Context<typeof definitionCanaryRun>,
    | RuntimeRequirement
    | ProgramRequirement
    | LinkDriver
    | RouterProvider
    | LedgerStorage
  >
>;
type ResultKeepsLiteralNames = Expect<
  Equal<
    ExitSuccess<
      ProgramExit<Effect.Effect.Success<typeof definitionCanaryRun>>
    >,
    readonly ["alice", "probe"]
  >
>;
type OpenedLedger = Effect.Effect.Success<
  ReturnType<typeof society.openLedger>
>;
type CompletedRecordsCannotFail = Expect<
  Equal<Stream.Stream.Error<OpenedLedger["records"]>, never>
>;
type RunOptionsOnlyDescribeRun = Expect<
  Equal<keyof SimulatorRunOptions, "provenance" | "metadata">
>;
type EmptyPartsAreRejected = Expect<
  Equal<readonly [] extends MessageParts ? true : false, false>
>;

/** Compile-time assertions for the public definition surface. */
export type DefinitionCanaries = [
  RunRequirementsAreExact,
  ResultKeepsLiteralNames,
  CompletedRecordsCannotFail,
  RunOptionsOnlyDescribeRun,
  EmptyPartsAreRejected,
];
