/** @file Runtime-definition validation and immutable configuration projection regressions. */

import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  AgentRuntimeDefinitionError,
  defineRuntime,
  runtimeConfigurationProjection,
} from "./agent.js";
import { AgentRoster } from "./roster.js";

const testRuntimeConfiguration = Schema.Struct({
  label: Schema.String,
});
const configuration = {
  schema: testRuntimeConfiguration,
  value: { label: "test" },
};

function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((member) => isDeeplyFrozen(member))
  );
}

// @agent-code-guard/regression-only: immutable metadata and invalid declarations pin container runtime construction invariants
it("validates roster keys when the definition constructs its roster", () => {
  const runtime = defineRuntime<
    undefined,
    never,
    typeof testRuntimeConfiguration
  >({
    name: "test",
    configuration,
  });
  assert.throws(() =>
    AgentRoster.make("acme.society/v1", {
      "Not Wire Safe": runtime,
    }),
  );
});

it("rejects empty runtime names before a run starts", () => {
  assert.throws(
    () =>
      defineRuntime({
        name: "",
        configuration,
      }),
    AgentRuntimeDefinitionError,
  );
});

it("copies and freezes roster declarations without mutating caller input", () => {
  const runtime = defineRuntime({
    name: "immutable",
    configuration,
  });
  const definitions = { alice: runtime };
  const roster = AgentRoster.make("acme.society/v1", definitions);

  assert.isFalse(Object.isFrozen(definitions));
  assert.notStrictEqual(roster.definitions, definitions);
  assert.strictEqual(roster.definitions.alice, runtime);
  assert.isTrue(Object.isFrozen(roster.definitions));
});

it("rejects runtime configurations that do not encode to JSON", () => {
  assert.throws(
    () =>
      defineRuntime({
        name: "invalid-configuration",
        configuration: {
          schema: Schema.Undefined,
          value: undefined,
        },
      }),
    AgentRuntimeDefinitionError,
  );
});

it("isolates the canonical projection and every native configuration view", () => {
  const mutableConfiguration = Schema.Struct({
    nested: Schema.Struct({
      labels: Schema.Array(Schema.String),
    }),
    at: Schema.Date,
  });
  const source = {
    nested: {
      labels: ["original"],
    },
    at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const runtime = defineRuntime({
    name: "snapshotted-configuration",
    configuration: {
      schema: mutableConfiguration,
      value: source,
    },
  });

  source.nested.labels.push("source-mutation");
  source.at.setUTCFullYear(2027);
  const first = runtime.configuration.value;
  const projection = runtimeConfigurationProjection(runtime);

  assert.isTrue(isDeeplyFrozen(projection));
  assert.isTrue(Reflect.set(first.nested.labels, "0", "native-mutation"));
  first.at.setUTCFullYear(2030);
  if (typeof projection === "object" && projection !== null) {
    assert.isFalse(Reflect.set(projection, "nested", null));
  }
  assert.deepStrictEqual(runtime.configuration.value, {
    nested: { labels: ["original"] },
    at: new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.deepStrictEqual(runtimeConfigurationProjection(runtime), {
    nested: { labels: ["original"] },
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.notStrictEqual(runtime.configuration.value, first);
});
