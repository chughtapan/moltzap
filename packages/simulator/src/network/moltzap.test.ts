/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/no-nested-functions, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- regression-only resource tests keep each acquisition and release timeline visible in one Effect program. */

import { it as effectIt } from "@effect/vitest";
import { AgentName } from "@moltzap/protocol/identity";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  conversationId,
  messageId,
  redactedAgentKey,
  taskId,
} from "@moltzap/protocol/testing";
import {
  makeRouterStopReport,
  networkFailure,
  routerSequence,
  type EndpointTransport,
} from "../network.js";
import { Duration, Effect, Exit, Schema, Scope, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  makeMoltZapRouterProviderWith,
  type MoltZapRouterDriver,
  type MoltZapRouterDriverAcquirer,
} from "./moltzap.js";
import { MoltZapServerFailed } from "./server.js";

const it = effectIt.scoped;
const STARTUP_TIMEOUT = Duration.seconds(10);
const ROUTER_URL = serverBaseUrl("http://127.0.0.1:43100");
const TASK_ID = taskId("00000000-0000-4000-8000-000000000101");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000102");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000103");
const agentName = Schema.decodeSync(AgentName);
const ALICE = agentName("alice");
const PROBE = agentName("probe");

function id(suffix: number) {
  return agentId(`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`);
}

function key(suffix: number) {
  return redactedAgentKey(agentKeyString(suffix));
}

const transport: EndpointTransport = {
  received: Stream.empty,
  openConversation: () => Effect.never,
  send: () => Effect.never,
};

interface Harness {
  readonly acquire: MoltZapRouterDriverAcquirer;
  readonly registrations: Array<string>;
  readonly readyDurations: Array<Duration.Duration>;
  readonly timeline: Array<string>;
}

function harness(
  awaitReady: Effect.Effect<void, unknown> = Effect.void,
): Harness {
  const registrations: Array<string> = [];
  const readyDurations: Array<Duration.Duration> = [];
  const timeline: Array<string> = [];
  const identities = new Map<string, number>();
  const stopped = makeRouterStopReport([
    {
      taskId: TASK_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      senderId: id(1),
      routerSequence: routerSequence(7),
    },
  ]);
  const driver: MoltZapRouterDriver = {
    address: ROUTER_URL,
    register: (name) =>
      Effect.sync(() => {
        registrations.push(name);
        const suffix = identities.get(name) ?? identities.size + 1;
        identities.set(name, suffix);
        return { agentId: id(suffix), key: key(suffix) };
      }),
    awaitAgentReady: (_agentId, within) =>
      Effect.sync(() => {
        readyDurations.push(within);
      }).pipe(Effect.zipRight(awaitReady)),
    attachEndpoint: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            timeline.push("endpoint-close");
          }),
        );
        return transport;
      }),
    stopAndCollect: Effect.sync(() => {
      timeline.push("router-stop");
      return stopped;
    }),
  };
  const acquire: MoltZapRouterDriverAcquirer = () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          timeline.push("driver-release");
        }),
      );
      return driver;
    });
  return {
    acquire,
    registrations,
    readyDurations,
    timeline,
  };
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

describe("MoltZap router", () => {
  it("keeps identities stable and completes stopped after scoped release", () =>
    Effect.gen(function* () {
      const test = harness();
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        test.acquire,
      );
      const scope = yield* Scope.make();
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const [firstAlice, secondAlice] = yield* Effect.all(
        [
          router.attachAgent("alice", ALICE).pipe(Scope.extend(scope)),
          router.attachAgent("alice", ALICE).pipe(Scope.extend(scope)),
        ],
        { concurrency: 2 },
      );
      const [firstProbe, secondProbe] = yield* Effect.all(
        [
          router.attachEndpoint("probe", PROBE).pipe(Scope.extend(scope)),
          router.attachEndpoint("probe", PROBE).pipe(Scope.extend(scope)),
        ],
        { concurrency: 2 },
      );
      const conflictingRole = yield* router
        .attachEndpoint("alice", ALICE)
        .pipe(Scope.extend(scope), Effect.flip);
      const readyWithin = Duration.seconds(3);

      yield* firstAlice.awaitReady(readyWithin);

      expect(router.address).toBe(ROUTER_URL);
      expect(firstAlice.routerUrl).toBe(ROUTER_URL);
      expect(firstAlice.agent.id).toBe(secondAlice.agent.id);
      expect(firstAlice.key).toBe(secondAlice.key);
      expect(firstProbe.participant.id).toBe(secondProbe.participant.id);
      expect(conflictingRole.operation).toBe("attach-endpoint");
      expect(conflictingRole.detail).toContain("already bound as an agent");
      expect(test.registrations).toEqual(["alice", "probe"]);
      expect(test.readyDurations).toEqual([readyWithin]);
      expect(test.timeline).toEqual([]);

      yield* close(scope);

      expect(test.timeline).toEqual([
        "endpoint-close",
        "endpoint-close",
        "router-stop",
        "driver-release",
      ]);
      const stopped = yield* router.stopped;
      expect(stopped.committedMessages).toEqual([
        {
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          senderId: id(1),
          routerSequence: routerSequence(7),
        },
      ]);
    }));

  it("maps acquisition and registration failures to network operations", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const unavailable = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        () => Effect.fail("docker unavailable"),
      );
      const acquisition = yield* unavailable.acquire.pipe(
        Scope.extend(scope),
        Effect.flip,
      );

      expect(acquisition.operation).toBe("acquire-router");
      expect(acquisition.detail).toContain("docker unavailable");

      const imageFailure = MoltZapServerFailed.make({
        operation: "resolve-image",
        detail: "Docker is not reachable",
      });
      const nested = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        () => Effect.fail(imageFailure),
      );
      const normalized = yield* nested.acquire.pipe(
        Scope.extend(scope),
        Effect.flip,
      );

      expect(normalized.detail).toBe(imageFailure.message);
      expect(normalized.message).toBe(
        `Network acquire-router failed: ${imageFailure.message}`,
      );
      expect(normalized.detail).not.toContain("MoltZapServerFailed:");

      const test = harness();
      const registrationFailed: MoltZapRouterDriverAcquirer = (options) =>
        test.acquire(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            register: () => Effect.fail("registration rejected"),
          })),
        );
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        registrationFailed,
      );
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const registration = yield* router
        .attachAgent("alice", ALICE)
        .pipe(Scope.extend(scope), Effect.flip);

      expect(registration.operation).toBe("attach-agent");
      expect(registration.detail).toContain("registration rejected");
      yield* close(scope);
    }));

  it("lets the runtime choose readiness duration and reports non-readiness", () =>
    Effect.gen(function* () {
      const timeout = harness(
        Effect.fail("agent alice was not router-visible within 2s"),
      );
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        timeout.acquire,
      );
      const scope = yield* Scope.make();
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const alice = yield* router
        .attachAgent("alice", ALICE)
        .pipe(Scope.extend(scope));
      const readyWithin = Duration.seconds(2);
      const failure = yield* alice.awaitReady(readyWithin).pipe(Effect.flip);

      expect(timeout.readyDurations).toEqual([readyWithin]);
      expect(failure.operation).toBe("attach-agent");
      expect(failure.detail).toContain("alice");
      expect(failure.detail).toContain("2s");
      yield* close(scope);
    }));

  it("normalizes endpoint attachment and release-time collection failures", () =>
    Effect.gen(function* () {
      const base = harness();
      const acquire: MoltZapRouterDriverAcquirer = (options) =>
        base.acquire(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            attachEndpoint: () => Effect.fail("socket authentication failed"),
            stopAndCollect: Effect.fail(
              networkFailure("stop-router", "traffic collection failed"),
            ),
          })),
        );
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        acquire,
      );
      const scope = yield* Scope.make();
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const attachment = yield* router
        .attachEndpoint("probe", PROBE)
        .pipe(Scope.extend(scope), Effect.flip);

      expect(attachment.operation).toBe("attach-endpoint");
      expect(attachment.detail).toContain("socket authentication failed");

      yield* close(scope);

      const stopped = yield* router.stopped.pipe(Effect.flip);
      expect(stopped.operation).toBe("stop-router");
      expect(stopped.detail).toContain("traffic collection failed");
    }));
});
