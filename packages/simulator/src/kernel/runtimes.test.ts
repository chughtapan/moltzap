import { assert, effect as test } from "@effect/vitest";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import { Effect, Schema } from "effect";
import type { linkEvents, runtimeEvents } from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import { makeAgentHandle } from "../network/participant.js";
import type { NetworkOperation, Router } from "../network/router.js";
import {
  RuntimeCompleted,
  RuntimeExited,
  defineRuntime,
} from "../runtime/runtime.js";
import { makeAgentRosterBuilder } from "../runtime/roster.js";
import { makeLinkFabric, type LinkFabric } from "./link-fabric.js";
import { acquireRoster } from "./runtimes.js";

const routerUrl = Schema.decodeUnknownSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
const key = redactedAgentKey(
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000",
);
const aliceId = agentId("00000000-0000-4000-8000-000000000001");
const bobId = agentId("00000000-0000-4000-8000-000000000002");
const runtimeConfiguration = Schema.Struct({});
const configuration = {
  schema: runtimeConfiguration,
  value: {},
};

const DISABLE_LINK_OPERATION: NetworkOperation = "disable-link";
const alphaGateway = Object.freeze({ runtime: "alpha" });
const betaGateway = Object.freeze({ runtime: "beta" });
const alphaTermination = Effect.succeed(RuntimeCompleted.make({}));
const betaTermination = Effect.succeed(RuntimeExited.make({ code: 0 }));

const alphaRuntime = defineRuntime({
  name: "alpha",
  configuration,
  acquire: () =>
    Effect.succeed({
      gateway: alphaGateway,
      termination: alphaTermination,
    }),
});
const betaRuntime = defineRuntime({
  name: "beta",
  configuration,
  acquire: () =>
    Effect.succeed({
      gateway: betaGateway,
      termination: betaTermination,
    }),
});
const roster = makeAgentRosterBuilder("acme.runtime-gateway-test/v1")({
  alice: alphaRuntime,
  bob: betaRuntime,
});

function testRouter(): Router {
  return {
    address: routerUrl,
    stopped: Effect.never,
    attachAgent: (name) =>
      Effect.succeed({
        agent: makeAgentHandle(name, name === "alice" ? aliceId : bobId),
        key,
        routerUrl,
        awaitReady: () => Effect.void,
      }),
    attachEndpoint: () => Effect.dieMessage("unused test endpoint"),
  };
}

function testWriter(): LedgerWriter<typeof runtimeEvents> {
  let logicalSequence = 0;
  return {
    write: ({ event }) =>
      Effect.sync(() => {
        const currentSequence = logicalSequence;
        logicalSequence += 1;
        return {
          runId: "runtime-gateway-test",
          eventId: `runtime-gateway-event-${String(currentSequence)}`,
          logicalSequence: currentSequence,
          elapsedNanos: 0n,
          observedAt: 0,
          producer: "kernel.runtime",
          event,
        };
      }),
  };
}

function testLinkWriter(): LedgerWriter<typeof linkEvents> {
  return {
    write: ({ event }) =>
      Effect.succeed({
        runId: "runtime-gateway-test",
        eventId: "runtime-gateway-link-event",
        logicalSequence: 0,
        elapsedNanos: 0n,
        observedAt: 0,
        producer: "kernel.link",
        event,
      }),
  };
}

function acquireTestRoster(fabric: LinkFabric) {
  return acquireRoster({
    router: testRouter(),
    roster,
    writer: testWriter(),
    interceptor: fabric.interceptor,
  });
}

// @agent-code-guard/regression-only: exact gateway identity and lifecycle capabilities must survive heterogeneous roster acquisition
test("installs each runtime gateway beside its router identity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* acquireTestRoster(
        yield* makeLinkFabric(testLinkWriter()),
      );

      assert.strictEqual(agents.alice.agent.id, aliceId);
      assert.strictEqual(agents.alice.gateway, alphaGateway);
      assert.strictEqual(agents.alice.termination, alphaTermination);
      assert.strictEqual(agents.bob.agent.id, bobId);
      assert.strictEqual(agents.bob.gateway, betaGateway);
      assert.strictEqual(agents.bob.termination, betaTermination);
      assert.isTrue(Object.isFrozen(agents));
      assert.isTrue(Object.isFrozen(agents.alice));
      assert.isTrue(Object.isFrozen(agents.bob));
    }),
  ));

test("an agent whose runtime never acquires the stage is no policy target", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fabric = yield* makeLinkFabric(testLinkWriter());
      yield* acquireTestRoster(fabric);

      const failure = yield* fabric.driver
        .disable(aliceId, bobId)
        .pipe(Effect.flip);

      assert.strictEqual(failure.operation, DISABLE_LINK_OPERATION);
    }),
  ));
