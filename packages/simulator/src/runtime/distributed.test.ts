import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as publicRuntime from "../runtime.js";
import {
  defineDistributedRuntime,
  distributedRuntimeCapability,
} from "./distributed.js";

const configuration = Schema.Struct({ kind: Schema.Literal("test") });

it("keeps distributed capabilities private to the exact runtime value", () => {
  const reservation = {
    image:
      "example.invalid/application@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    resources: {
      cpuMillis: 100,
      memoryBytes: 1_024,
      ephemeralStorageBytes: 2_048,
    },
  };
  const render = () => Effect.die("unused");
  const runtime = defineDistributedRuntime({
    name: "private-distributed-test",
    configuration: {
      schema: configuration,
      value: { kind: "test" },
    },
    reservation,
    render,
  });
  const keysBeforeRegistration = Reflect.ownKeys(runtime);
  const capability = distributedRuntimeCapability(runtime);

  assert.deepStrictEqual(Reflect.ownKeys(runtime), keysBeforeRegistration);
  assert.deepStrictEqual(capability?.reservation, reservation);
  assert.strictEqual(capability?.render, render);
  const copiedRuntime: typeof runtime = { ...runtime };
  assert.isUndefined(distributedRuntimeCapability(copiedRuntime));
  assert.notProperty(publicRuntime, "distributedRuntimeCapability");
  assert.notProperty(publicRuntime, "registerDistributedRuntimeCapability");
  assert.strictEqual(
    publicRuntime.defineDistributedRuntime,
    defineDistributedRuntime,
  );
});
