/** @file Roster gateway installation and pre-dispatch runtime termination. */

import { assert, effect as test } from "@effect/vitest";
import { AgentId, type AgentName } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type { CredentialName } from "../agents/container.js";
import type { LedgerWriter } from "../ledger/append.js";
import {
  defineFakeRuntime,
  makeFakeCluster,
} from "../__tests__/fake-cluster.js";
import { RuntimeExited } from "../agents/agent.js";
import { AgentRoster } from "../agents/roster.js";
import { ClusterError } from "../cluster/cluster.js";
import { AgentRuntimeReady, type runtimeEvents } from "../events/core.js";
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

const roster = AgentRoster.make("acme.runtime-lifecycle-test/v1", {
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

/**
 * What each agent's cluster forwards: several names in table order for one,
 * nothing for the other, which a ledger carries as an empty list rather than
 * an absent field.
 */
const FORWARDED: Readonly<Record<string, readonly CredentialName[]>> = {
  alice: ["OPENAI_API_KEY", "CODEX_AUTH_JSON"],
  bob: [],
};

function testWriter(
  written: unknown[] = [],
): LedgerWriter<typeof runtimeEvents> {
  let logicalSequence = 0;
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        const currentSequence = logicalSequence;
        logicalSequence += 1;
        written.push(event);
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

test("writes each agent's forwarded credential names, or an empty list, onto its own ready event and started agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const written: unknown[] = [];
      const fake = yield* makeFakeCluster({ agentIdFor }).prepare(roster);
      const session: typeof fake = {
        ...fake,
        acquireAgent: (input) =>
          fake.acquireAgent(input).pipe(
            Effect.map((started) => ({
              ...started,
              credentials: FORWARDED[input.name] ?? [],
            })),
          ),
      };

      const agents = yield* acquireRoster({
        roster,
        session,
        writer: testWriter(written),
      });

      const ready = written.filter(
        (event) => event instanceof AgentRuntimeReady,
      );
      assert.deepStrictEqual(
        Object.fromEntries(
          ready.map((event) => [event.agentName, event.credentials]),
        ),
        FORWARDED,
      );
      assert.deepStrictEqual(agents.alice.credentials, FORWARDED.alice);
      assert.deepStrictEqual(agents.bob.credentials, FORWARDED.bob);
      for (const event of ready) {
        assert.deepStrictEqual(
          Schema.decodeUnknownSync(AgentRuntimeReady)(
            Schema.encodeSync(AgentRuntimeReady)(event),
          ).credentials,
          event.credentials,
        );
      }
    }),
  ));

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
      const terminatedRoster = AgentRoster.make(
        "acme.runtime-pre-dispatch-loss/v1",
        { alice: terminated },
      );
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
