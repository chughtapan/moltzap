import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { Simulator, SimulatorDefinitionError } from "./definition.js";
import { RuntimeCompleted, defineRuntime } from "./runtime/runtime.js";

const runtime = defineRuntime({
  name: "definition-binding-test",
  acquire: () =>
    Effect.succeed({
      termination: Effect.succeed(RuntimeCompleted.make({})),
    }),
});

it("rejects a roster owned by a distinct definition with the same id", () => {
  const first = Simulator.define("acme.definition-binding/v1");
  const second = Simulator.define("acme.definition-binding/v1");
  const roster = first.agents({ alice: runtime });

  assert.throws(
    () => second.run(roster, Effect.void),
    SimulatorDefinitionError,
  );
});
