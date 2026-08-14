/** @file Roster gateway installation and pre-dispatch runtime-termination regressions. */

import { assert, effect as test } from "@effect/vitest";
import { AgentId, type AgentName } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { runtimeEvents } from "../events/core.js";
import type { LedgerWriter } from "../ledger/append.js";
import { RuntimeExited } from "../agents/agent.js";
import { makeAgentRosterBuilder } from "../agents/roster.js";
import { ClusterError } from "../cluster/cluster.js";
import { defineFakeRuntime, makeFakeCluster } from "../cluster/fake.js";
import { acquireRoster } from "./acquire.js";

const configuration = {
  schema: Schema.Struct({}),
  value: {},
};
const alphaGateway = Object.freeze({ runtime: "alpha" });
const betaGateway = Object.freeze({ runtime: "beta" });
const alphaTermination = Effect.never;
const betaTermination = Effect.never;
const ALICE_NAME = "alice";
const BOB_NAME = "bob";

function agentIdFor(agentName: AgentName) {
  return Schema.decodeSync(AgentId)(
    agentName === ALICE_NAME
      ? "agt_AAAAAAAAAAAAAAAAAAAAAA"
      : "agt_AQAAAAAAAAAAAAAAAAAAAA",
  );
}

const roster = makeAgentRosterBuilder("acme.runtime-lifecycle-test/v1")({
  alice: defineFakeRuntime({
    name: "alpha",
    configuration,
    acquire: () =>
      Effect.succeed({
        gateway: alphaGateway,
        termination: alphaTermination,
      }),
  }),
  bob: defineFakeRuntime({
    name: "beta",
    configuration,
    acquire: () =>
      Effect.succeed({
        gateway: betaGateway,
        termination: betaTermination,
      }),
  }),
});

function testWriter(): LedgerWriter<typeof runtimeEvents> {
  let logicalSequence = 0;
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        const currentSequence = logicalSequence;
        logicalSequence += 1;
        return {
          runId: "runtime-lifecycle-test",
          eventId: `runtime-lifecycle-event-${String(currentSequence)}`,
          logicalSequence: currentSequence,
          elapsedNanos: 0n,
          observedAt: 0,
          producer: "kernel.runtime",
          event,
        };
      }),
  };
}

test("installs each runtime gateway under its roster-owned name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* makeFakeCluster({ agentIdFor }).prepare(roster);
      const agents = yield* acquireRoster({
        roster,
        session,
        writer: testWriter(),
      });

      assert.strictEqual(agents.alice.agent.name, ALICE_NAME);
      assert.strictEqual(agents.alice.gateway, alphaGateway);
      assert.strictEqual(agents.alice.termination, alphaTermination);
      assert.strictEqual(agents.bob.agent.name, BOB_NAME);
      assert.strictEqual(agents.bob.gateway, betaGateway);
      assert.strictEqual(agents.bob.termination, betaTermination);
      assert.isTrue(Object.isFrozen(agents));
      assert.isTrue(Object.isFrozen(agents.alice));
      assert.isTrue(Object.isFrozen(agents.bob));
    }),
  ));

test("rejects an already-terminated runtime before the cohort gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminated = defineFakeRuntime({
        name: "terminated-before-cohort",
        configuration,
        acquire: () =>
          Effect.succeed({
            gateway: undefined,
            termination: Effect.succeed(RuntimeExited.make({ code: 0 })),
          }),
      });
      const terminatedRoster = makeAgentRosterBuilder(
        "acme.runtime-pre-dispatch-loss/v1",
      )({ alice: terminated });
      const session = yield* makeFakeCluster({ agentIdFor }).prepare(
        terminatedRoster,
      );
      const failure = yield* acquireRoster({
        roster: terminatedRoster,
        session,
        writer: testWriter(),
      }).pipe(Effect.flip);

      assert.instanceOf(failure, ClusterError);
    }),
  ));
