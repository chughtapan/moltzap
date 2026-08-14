/** @file Private container realizations and digest-pinned image boundary regressions. */

import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { defineRuntime } from "./agent.js";
import {
  containerRuntimeFor,
  defineContainerRuntime,
  image,
} from "./container.js";
import * as publicRuntime from "./index.js";

const configuration = Schema.Struct({ kind: Schema.Literal("test") });

const IMAGE = image.make(
  "example.invalid/application@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
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

  assert.strictEqual(container.image, IMAGE);
  assert.deepStrictEqual(container.resources, RESOURCES);
  assert.strictEqual(container.render, render);
  assert.notProperty(publicRuntime, "containerRuntimeFor");
  assert.strictEqual(
    publicRuntime.defineContainerRuntime,
    defineContainerRuntime,
  );
});

it("accepts only an image pinned by one lowercase SHA-256 digest", () => {
  const digest = "a".repeat(64);

  assert.strictEqual(
    image.make(`example.invalid/application@sha256:${digest}`),
    `example.invalid/application@sha256:${digest}`,
  );
  for (const rejected of [
    "example.invalid/application",
    "example.invalid/application@sha256:short",
    `example.invalid/application@sha256:${"A".repeat(64)}`,
    // A repository half that may contain "@" lets an unpinned reference carry
    // a well-formed digest behind it.
    `example.invalid/app@sha256:junk@sha256:${digest}`,
  ]) {
    assert.throws(() => image.make(rejected));
  }
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
