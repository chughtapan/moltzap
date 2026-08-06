import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Run, RunSpec, SimulatorDefinitionError } from "./definition.js";
import { EventCatalog } from "./events/catalog.js";
import { LedgerStorage } from "./ledger/storage.js";
import { RouterProvider } from "./network/router.js";
import { Cluster } from "./cluster/cluster.js";
import { defineRuntime } from "./agents/agent.js";

const testRuntimeConfiguration = Schema.Struct({});
const configuration = {
  schema: testRuntimeConfiguration,
  value: {},
};

const runtime = defineRuntime({
  name: "definition-binding-test",
  configuration,
});

class DefinitionObservation extends Schema.TaggedClass<DefinitionObservation>()(
  "acme.definition-observation/v1",
  { value: Schema.String },
) {}

const definitionEvents = EventCatalog.make(DefinitionObservation);

function definitionCluster() {
  return Layer.mergeAll(
    Layer.effect(LedgerStorage, Effect.never),
    Layer.effect(RouterProvider, Effect.never),
    Layer.effect(Cluster, Effect.never),
  );
}

it("captures an immutable RunSpec without freezing caller-owned input", () => {
  const events = [definitionEvents];
  const agents = { alice: runtime };
  const replacementRuntime = defineRuntime({
    name: "definition-binding-replacement",
    configuration,
  });
  const cluster = definitionCluster();
  const replacementCluster = definitionCluster();
  const execute = () => Effect.succeed("original");
  const replacementExecute = () => Effect.succeed("replacement");
  const input = {
    id: "acme.run-spec-snapshot/v1" as const,
    events,
    agents,
    cluster,
    execute,
  };

  const spec = RunSpec.define(input);
  input.events = [];
  agents.alice = replacementRuntime;
  input.cluster = replacementCluster;
  input.execute = replacementExecute;

  assert.strictEqual(spec.events.length, 1);
  assert.strictEqual(spec.events[0], definitionEvents);
  assert.strictEqual(spec.agents.alice, runtime);
  assert.strictEqual(spec.cluster, cluster);
  assert.strictEqual(spec.execute, execute);
  assert.isTrue(Object.isFrozen(spec));
  assert.isTrue(Object.isFrozen(spec.events));
  assert.isTrue(Object.isFrozen(spec.agents));
  assert.isFalse(Object.isFrozen(events));
  assert.notStrictEqual(spec.events, events);
  assert.deepStrictEqual(Reflect.ownKeys(spec), [
    "id",
    "events",
    "agents",
    "cluster",
    "execute",
    Symbol.for("@moltzap/simulator/RunSpec"),
  ]);
  assert.throws(
    () => Run.execute({ ...spec, execute: replacementExecute }),
    SimulatorDefinitionError,
  );
});
