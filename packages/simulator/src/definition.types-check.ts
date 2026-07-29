/**
 * A definition-bound run removes only the services it installs. Platform,
 * runtime, and customer requirements remain explicit, while endpoint
 * acquisition does not leak Scope into experiment code. Run options describe
 * the run without altering event truth. Opening validates the complete ledger
 * before returning, so its in-memory streams cannot fail.
 */

import { Context, Data, Effect, Exit, Stream } from "effect";
import {
  LinkController,
  LinkDriver,
  Network,
  RouterProvider,
} from "./network.js";
import { RuntimeCompleted, defineRuntime } from "./runtime/runtime.js";
import { LedgerStorage } from "./ledger/storage.js";
import { Simulator } from "./definition.js";
import type { SimulatorRunOptions } from "./kernel/run.js";

class RuntimeRequirement extends Context.Tag(
  "@moltzap/simulator/test/RuntimeRequirement",
)<RuntimeRequirement, { readonly runtime: true }>() {}

class ProgramRequirement extends Context.Tag(
  "@moltzap/simulator/test/ProgramRequirement",
)<ProgramRequirement, { readonly program: true }>() {}

class RuntimeUnavailable extends Data.TaggedError("RuntimeUnavailable")<{
  readonly detail: string;
}> {}

const runtime = defineRuntime<RuntimeUnavailable, RuntimeRequirement>({
  name: "type-canary",
  acquire: () =>
    Effect.gen(function* () {
      yield* RuntimeRequirement;
      return {
        termination: Effect.succeed(RuntimeCompleted.make({})),
      };
    }),
});

const Society = Simulator.define("acme.type-canary/v1");
const roster = Society.agents({
  alice: runtime,
});

const program = Effect.gen(function* () {
  const agents = yield* roster.Agents;
  yield* Society.Ledger;
  yield* Society.Events;
  const network = yield* Network;
  const links = yield* LinkController;
  yield* ProgramRequirement;
  const probe = yield* network.endpoint("probe");
  const conversation = yield* probe.open(agents.alice);
  yield* conversation.send("hello");
  // @ts-expect-error Message-part arrays are nonempty.
  yield* conversation.send([]);
  yield* links.disable(agents.alice, probe.participant);
  return [agents.alice.name, probe.participant.name] as const;
});

const run = Society.run(roster, program);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ExitSuccess<Outcome> =
  Outcome extends Exit.Exit<infer Success, infer _Failure> ? Success : never;

type RunRequirementsAreExact = Expect<
  Equal<
    Effect.Effect.Context<typeof run>,
    | RuntimeRequirement
    | ProgramRequirement
    | LinkDriver
    | RouterProvider
    | LedgerStorage
  >
>;
type ResultKeepsLiteralNames = Expect<
  Equal<
    ExitSuccess<Effect.Effect.Success<typeof run>["exit"]>,
    readonly ["alice", "probe"]
  >
>;
type OpenedLedger = Effect.Effect.Success<
  ReturnType<typeof Society.openLedger>
>;
type CompletedRecordsCannotFail = Expect<
  Equal<Stream.Stream.Error<OpenedLedger["records"]>, never>
>;
type RunOptionsOnlyDescribeRun = Expect<
  Equal<keyof SimulatorRunOptions, "provenance" | "metadata">
>;

type _Canaries =
  | RunRequirementsAreExact
  | ResultKeepsLiteralNames
  | CompletedRecordsCannotFail
  | RunOptionsOnlyDescribeRun;
