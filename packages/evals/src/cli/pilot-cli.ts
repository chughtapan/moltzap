/** @file Explicit opt-in entrypoint for incremental shared-suite pilots. */
import { Command as CliCommand, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { decodePilotPlan, runPilot } from "./pilot.js";

const pilot = CliCommand.make(
  "pilot",
  { plan: Options.file("plan") },
  ({ plan }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(plan);
      const decoded = yield* decodePilotPlan(text);
      const receipt = yield* runPilot(decoded);
      yield* Effect.log(JSON.stringify(receipt));
    }),
);
const main = CliCommand.run(pilot, {
  name: "Shared eval pilot",
  version: "0.1.0",
});
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- @effect/cli consumes host argv at this executable boundary.
main(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain({
    teardown: (exit, onExit) => {
      onExit(Exit.isFailure(exit) ? 1 : 0);
    },
  }),
);
