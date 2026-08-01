import { assert, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { makeAgentHandle } from "../network/participant.js";
import type { AgentConnection } from "../network/router.js";
import {
  AgentRuntimeDefinitionError,
  RuntimeCompleted,
  defineRuntime,
  runtimeConfigurationProjection,
} from "./runtime.js";
import { makeAgentRosterBuilder } from "./roster.js";

const ALICE_ID = agentId("00000000-0000-4000-8000-000000000001");
const ALICE_NAME = agentName("alice");
const key = redactedAgentKey(
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000",
);
const routerUrl = Schema.decodeUnknownSync(serverBaseUrlSchema)(
  "http://127.0.0.1:3000",
);
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

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle("alice", ALICE_ID),
  key,
  routerUrl,
};

// @agent-code-guard/regression-only: exact scoped acquisition and invalid declaration cases pin runtime construction invariants
it.effect("releases an acquired runtime with its caller scope", () =>
  Effect.gen(function* () {
    const released = yield* Ref.make(false);
    const runtime = defineRuntime<
      undefined,
      never,
      never,
      typeof testRuntimeConfiguration
    >({
      name: "scoped",
      configuration,
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({
            gateway: undefined,
            termination: Effect.succeed(RuntimeCompleted.make({})),
          }),
          () => Ref.set(released, true),
        ),
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const running = yield* runtime.acquire({
          agentName: ALICE_NAME,
          connection,
        });
        const termination = yield* running.termination;

        assert.instanceOf(termination, RuntimeCompleted);
        assert.isFalse(yield* Ref.get(released));
      }),
    );

    assert.isTrue(yield* Ref.get(released));
  }),
);

it("validates roster keys when the definition constructs its roster", () => {
  const runtime = defineRuntime<
    undefined,
    never,
    never,
    typeof testRuntimeConfiguration
  >({
    name: "test",
    configuration,
    acquire: () =>
      Effect.succeed({
        gateway: undefined,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      }),
  });
  const makeRoster = makeAgentRosterBuilder("acme.society/v1");

  assert.throws(() =>
    makeRoster({
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
        acquire: () =>
          Effect.succeed({
            gateway: undefined,
            termination: Effect.succeed(RuntimeCompleted.make({})),
          }),
      }),
    AgentRuntimeDefinitionError,
  );
});

it.effect("captures runtime behavior when the definition is constructed", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const source = {
      name: "captured",
      configuration,
      acquire: () =>
        Effect.sync(() => {
          calls.push("original");
          return {
            gateway: undefined,
            termination: Effect.succeed(RuntimeCompleted.make({})),
          };
        }),
    };
    const runtime = defineRuntime(source);
    source.acquire = () =>
      Effect.sync(() => {
        calls.push("mutated");
        return {
          gateway: undefined,
          termination: Effect.succeed(RuntimeCompleted.make({})),
        };
      });

    yield* Effect.scoped(
      runtime.acquire({ agentName: ALICE_NAME, connection }),
    );

    assert.deepStrictEqual(calls, ["original"]);
  }),
);

it("copies and freezes roster declarations without mutating caller input", () => {
  const runtime = defineRuntime({
    name: "immutable",
    configuration,
    acquire: () =>
      Effect.succeed({
        gateway: undefined,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      }),
  });
  const definitions = { alice: runtime };
  const roster = makeAgentRosterBuilder("acme.society/v1")(definitions);

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
        acquire: () =>
          Effect.succeed({
            gateway: undefined,
            termination: Effect.succeed(RuntimeCompleted.make({})),
          }),
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
    acquire: () =>
      Effect.succeed({
        gateway: undefined,
        termination: Effect.succeed(RuntimeCompleted.make({})),
      }),
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
