import { describe, expect, it, afterEach, vi } from "vitest";
import { Deferred, Effect, Either, Exit, Fiber } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";

import {
  launchRuntimeFleet,
  launchRuntimeFleetWithProcessSignals,
  RuntimeFleetStartupInterrupted,
  startRuntimeAgent,
  type RuntimeAgentSpec,
} from "./fleet.js";
import type { ReadyOutcome, Runtime, RuntimeServerHandle } from "./runtime.js";
import { RuntimeReadyTimedOut } from "./errors.js";

const fleetRuntimeFactoryState = vi.hoisted(() => ({
  nextRuntime: null as null | (() => Runtime),
}));

const READY_TAG = "Ready";
const TIMEOUT_TAG = "Timeout";
const OPENCLAW_KIND = "openclaw";
const INBOUND_MARKER = "inbound from agent:";
const TEST_AGENT_NAME = "test-agent";
const TEST_API_KEY = redactedAgentKey(agentKeyString(80));
const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const TEST_SERVER_URL = "ws://localhost:9999/ws";
const ALPHA_AGENT_NAME = "alpha";
const ALPHA_AGENT_ID = agentId("22222222-2222-4222-8222-222222222222");
const BETA_AGENT_NAME = "beta";
const BETA_AGENT_ID = agentId("33333333-3333-4333-8333-333333333333");
const STARTUP_SIGNAL = "SIGUSR2";
const READY_TIMEOUT_MS = 1_000;
const LONG_READY_TIMEOUT_MS = 60_000;
const SHORT_READY_TIMEOUT_MS = 250;

vi.mock("./openclaw-adapter.js", () => ({
  createWorkspaceOpenClawAdapter: vi.fn(() => {
    const factory = fleetRuntimeFactoryState.nextRuntime;
    if (factory === null) {
      throw new Error("Expected a configured runtime factory for fleet tests");
    }
    return factory();
  }),
}));

afterEach(() => {
  fleetRuntimeFactoryState.nextRuntime = null;
});

describe("runtime fleet lifecycle", () => {
  it(
    "property: successful fleet launch keeps runtimes alive until stopAll",
    successfulFleetLaunchKeepsRuntimesUntilStopAll,
  );
  it(
    "tears down an in-flight runtime when startRuntimeAgent is interrupted",
    startRuntimeAgentInterruptionTearsDownRuntime,
  );
  it(
    "tears down ready and in-flight runtimes when launchRuntimeFleet is interrupted mid-startup",
    fleetInterruptionTearsDownStartedAndInFlightRuntimes,
  );
  it(
    "tears down an in-flight fleet when a configured process signal arrives",
    processSignalTearsDownInFlightFleet,
  );
  it(
    "tears down previously started and failing runtimes before fleet launch returns an error",
    fleetLaunchFailureTearsDownStartedAndFailingRuntimes,
  );
});

function successfulFleetLaunchKeepsRuntimesUntilStopAll() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      setMockFleetRuntimes(first.runtime, second.runtime);

      const fleet = yield* launchRuntimeFleet({
        kind: OPENCLAW_KIND,
        server: stubServer(),
        agents: alphaBetaAgentSpecs(),
        readyTimeoutMs: READY_TIMEOUT_MS,
      }).pipe(Effect.orDie);

      expect(fleet.agents).toEqual([
        { name: ALPHA_AGENT_NAME, agentId: ALPHA_AGENT_ID },
        { name: BETA_AGENT_NAME, agentId: BETA_AGENT_ID },
      ]);
      expect(first.stats.teardownCalls).toBe(0);
      expect(second.stats.teardownCalls).toBe(0);

      yield* fleet.stopAll();
      expect(first.stats.teardownCalls).toBe(1);
      expect(second.stats.teardownCalls).toBe(1);
    }),
  );
}

function startRuntimeAgentInterruptionTearsDownRuntime() {
  return runTest(
    Effect.gen(function* () {
      const blocked = yield* createMockRuntime({
        readyEffect: Effect.never,
      });
      setMockFleetRuntimes(blocked.runtime);

      const fiber = Effect.runFork(
        startRuntimeAgent({
          kind: OPENCLAW_KIND,
          server: stubServer(),
          agent: stubRuntimeAgentSpec(),
          readyTimeoutMs: LONG_READY_TIMEOUT_MS,
        }),
      );

      yield* blocked.waitStarted;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(blocked.stats.spawnCalls).toBe(1);
      expect(blocked.stats.waitCalls).toBe(1);
      expect(blocked.stats.teardownCalls).toBe(1);
    }),
  );
}

function fleetInterruptionTearsDownStartedAndInFlightRuntimes() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.never,
      });
      setMockFleetRuntimes(first.runtime, second.runtime);

      const fiber = Effect.runFork(
        launchRuntimeFleet({
          kind: OPENCLAW_KIND,
          server: stubServer(),
          agents: alphaBetaAgentSpecs(),
          readyTimeoutMs: LONG_READY_TIMEOUT_MS,
        }),
      );

      yield* second.waitStarted;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(first.stats.teardownCalls).toBe(1);
      expect(second.stats.teardownCalls).toBe(1);
    }),
  );
}

function processSignalTearsDownInFlightFleet() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.never,
      });
      setMockFleetRuntimes(first.runtime, second.runtime);

      const fiber = Effect.runFork(
        Effect.either(
          launchRuntimeFleetWithProcessSignals({
            kind: OPENCLAW_KIND,
            server: stubServer(),
            agents: alphaBetaAgentSpecs(),
            readyTimeoutMs: LONG_READY_TIMEOUT_MS,
            signals: [STARTUP_SIGNAL],
          }),
        ),
      );

      yield* second.waitStarted;
      yield* Effect.sync(() => {
        process.emit(STARTUP_SIGNAL);
      });
      const result = yield* Fiber.join(fiber);

      Either.match(result, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(RuntimeFleetStartupInterrupted);
          if (error._tag !== "RuntimeFleetStartupInterrupted") {
            return expect.fail();
          }
          expect(error.signal).toBe(STARTUP_SIGNAL);
        },
        onRight: () => expect.fail(),
      });
      expect(first.stats.teardownCalls).toBe(1);
      expect(second.stats.teardownCalls).toBe(1);
    }),
  );
}

function fleetLaunchFailureTearsDownStartedAndFailingRuntimes() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.succeed({
          _tag: TIMEOUT_TAG,
          timeoutMs: SHORT_READY_TIMEOUT_MS,
        }),
      });
      setMockFleetRuntimes(first.runtime, second.runtime);

      const result = yield* Effect.either(
        launchRuntimeFleet({
          kind: OPENCLAW_KIND,
          server: stubServer(),
          agents: alphaBetaAgentSpecs(),
          readyTimeoutMs: SHORT_READY_TIMEOUT_MS,
        }),
      );

      Either.match(result, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(RuntimeReadyTimedOut);
          expect(error.agentName).toBe(BETA_AGENT_NAME);
        },
        onRight: () => expect.fail(),
      });
      expect(first.stats.teardownCalls).toBe(1);
      expect(second.stats.teardownCalls).toBe(1);
    }),
  );
}

interface MockRuntimeStats {
  spawnCalls: number;
  waitCalls: number;
  teardownCalls: number;
}

interface MockRuntimeHandle {
  readonly runtime: Runtime;
  readonly stats: MockRuntimeStats;
  readonly waitStarted: Effect.Effect<void, never, never>;
}

function runTest<A>(effect: Effect.Effect<A, never, never>) {
  return Effect.runPromise(effect);
}

function stubServer(): RuntimeServerHandle {
  return {
    awaitAgentReady: (_agentId, _timeoutMs: number) => Effect.never,
  };
}

function stubRuntimeAgentSpec(
  overrides?: Partial<RuntimeAgentSpec>,
): RuntimeAgentSpec {
  return {
    agentName: TEST_AGENT_NAME,
    apiKey: TEST_API_KEY,
    agentId: TEST_AGENT_ID,
    serverUrl: TEST_SERVER_URL,
    ...overrides,
  };
}

function alphaBetaAgentSpecs(): ReadonlyArray<RuntimeAgentSpec> {
  return [
    stubRuntimeAgentSpec({
      agentName: ALPHA_AGENT_NAME,
      agentId: ALPHA_AGENT_ID,
    }),
    stubRuntimeAgentSpec({
      agentName: BETA_AGENT_NAME,
      agentId: BETA_AGENT_ID,
    }),
  ];
}

function setMockFleetRuntimes(...runtimes: ReadonlyArray<Runtime>): void {
  const queue = [...runtimes];
  fleetRuntimeFactoryState.nextRuntime = () => {
    const runtime = queue.shift();
    if (runtime === undefined) {
      throw new Error("No mocked runtime remaining for fleet test");
    }
    return runtime;
  };
}

function createMockRuntime(options: {
  readonly readyEffect: Effect.Effect<ReadyOutcome, never, never>;
}) {
  return Effect.gen(function* () {
    const stats: MockRuntimeStats = {
      spawnCalls: 0,
      waitCalls: 0,
      teardownCalls: 0,
    };
    const waitStarted = yield* Deferred.make<void, never>();

    const runtime: Runtime = {
      spawn: () =>
        Effect.sync(() => {
          stats.spawnCalls += 1;
        }),
      waitUntilReady: () =>
        Deferred.succeed(waitStarted, undefined).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              stats.waitCalls += 1;
            }),
          ),
          Effect.zipRight(options.readyEffect),
        ),
      teardown: () =>
        Effect.sync(() => {
          stats.teardownCalls += 1;
        }),
      getLogs: () => ({ text: "", nextOffset: 0 }),
      getInboundMarker: () => INBOUND_MARKER,
    };

    return {
      runtime,
      stats,
      waitStarted: Deferred.await(waitStarted),
    } satisfies MockRuntimeHandle;
  });
}
