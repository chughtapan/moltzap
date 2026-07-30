import { assert, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import { makeAgentHandle } from "../network/participant.js";
import type { AgentConnection } from "../network/router.js";
import {
  AgentRuntimeDefinitionError,
  RuntimeCompleted,
  defineRuntime,
} from "./runtime.js";
import { makeAgentRosterBuilder } from "./roster.js";

const ALICE_ID = agentId("00000000-0000-4000-8000-000000000001");
const key = redactedAgentKey(
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000",
);
const routerUrl = Schema.decodeUnknownSync(serverBaseUrlSchema)(
  "http://127.0.0.1:3000",
);

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle("alice", ALICE_ID),
  key,
  routerUrl,
  awaitReady: () => Effect.void,
};

// @agent-code-guard/regression-only: exact scoped acquisition and invalid declaration cases pin runtime construction invariants
it.effect("releases an acquired runtime with its caller scope", () =>
  Effect.gen(function* () {
    const released = yield* Ref.make(false);
    const runtime = defineRuntime<never, never>({
      name: "scoped",
      acquire: () =>
        Effect.acquireRelease(
          Effect.succeed({
            termination: Effect.succeed(RuntimeCompleted.make({})),
          }),
          () => Ref.set(released, true),
        ),
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const running = yield* runtime.acquire({ connection });
        const termination = yield* running.termination;

        assert.instanceOf(termination, RuntimeCompleted);
        assert.isFalse(yield* Ref.get(released));
      }),
    );

    assert.isTrue(yield* Ref.get(released));
  }),
);

it("validates roster keys when the definition constructs its roster", () => {
  const runtime = defineRuntime<never, never>({
    name: "test",
    acquire: () =>
      Effect.succeed({
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
        acquire: () =>
          Effect.succeed({
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
      acquire: () =>
        Effect.sync(() => {
          calls.push("original");
          return {
            termination: Effect.succeed(RuntimeCompleted.make({})),
          };
        }),
    };
    const runtime = defineRuntime(source);
    source.acquire = () =>
      Effect.sync(() => {
        calls.push("mutated");
        return {
          termination: Effect.succeed(RuntimeCompleted.make({})),
        };
      });

    yield* Effect.scoped(runtime.acquire({ connection }));

    assert.deepStrictEqual(calls, ["original"]);
  }),
);

it("copies and freezes roster declarations without mutating caller input", () => {
  const runtime = defineRuntime({
    name: "immutable",
    acquire: () =>
      Effect.succeed({
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
