import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as publicRuntime from "../agents.js";
import { defineRuntime } from "./agent.js";
import { defineContainerRuntime, containerRuntimeFor } from "./container.js";

const configuration = Schema.Struct({ kind: Schema.Literal("test") });

const IMAGE =
  "example.invalid/application@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESOURCES = {
  cpuMillis: 100,
  memoryBytes: 1_024,
  ephemeralStorageBytes: 2_048,
};

it("keeps container realizations off the published runtime surface", () => {
  const render = () => Effect.die("unused");
  const runtime = defineContainerRuntime({
    name: "private-container-test",
    configuration: { schema: configuration, value: { kind: "test" } },
    image: IMAGE,
    resources: RESOURCES,
    render,
  });
  const container = containerRuntimeFor(runtime);

  assert.strictEqual(container?.image, IMAGE);
  assert.deepStrictEqual(container?.resources, RESOURCES);
  assert.strictEqual(container?.render, render);
  assert.notProperty(publicRuntime, "containerRuntimeFor");
  assert.strictEqual(
    publicRuntime.defineContainerRuntime,
    defineContainerRuntime,
  );
});

it("refuses a runtime that never declared a container realization", () => {
  const runtime = defineRuntime<
    { readonly gateway: string },
    never,
    typeof configuration
  >({
    name: "plain-runtime-test",
    configuration: { schema: configuration, value: { kind: "test" } },
  });

  assert.isUndefined(containerRuntimeFor(runtime));
});
