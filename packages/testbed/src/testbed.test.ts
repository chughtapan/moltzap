import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { Deferred, Effect, Either, Exit, Fiber, Option } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";

import {
  launchTestbed,
  launchTestbedWithProcessSignals,
  TestbedStartupInterrupted,
  startRuntimeAgent,
  type RuntimeStartOptions,
  type TestbedAgentSpec,
  type TestbedLaunchOptions,
} from "./testbed.js";
import type { ReadyOutcome, Runtime, RuntimeServerHandle } from "./runtime.js";
import { RuntimeReadyTimedOut } from "./errors.js";
import { createOpenClawAdapter } from "./openclaw-adapter.js";

const testbedRuntimeFactoryState = vi.hoisted(() => ({
  nextRuntime: null as null | (() => Runtime),
}));
const installModeMocks = vi.hoisted(() => ({
  resolveInstallMode: vi.fn(),
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
const PUBLISHED_INSTALL_MODE = "published";
const WORKSPACE_INSTALL_MODE = "workspace";

type RuntimeStartOptionsBase = {
  readonly server: RuntimeServerHandle;
  readonly agent: TestbedAgentSpec;
  readonly readyTimeoutMs: number;
};

type TestbedLaunchOptionsBase = {
  readonly server: RuntimeServerHandle;
  readonly agents: ReadonlyArray<TestbedAgentSpec>;
  readonly readyTimeoutMs: number;
};

type NanoclawWithOpenClawOptions = {
  readonly kind: "nanoclaw";
  readonly openclaw: { readonly openclawBin: string };
};

type OpenClawWithNanoclawOptions = {
  readonly kind: "openclaw";
  readonly nanoclaw: { readonly autoRegisterConversations: true };
};

vi.mock("./openclaw-adapter.js", () => ({
  createOpenClawAdapter: vi.fn(() => {
    const factory = testbedRuntimeFactoryState.nextRuntime;
    if (factory === null) {
      throw new Error(
        "Expected a configured runtime factory for testbed tests",
      );
    }
    return factory();
  }),
}));

vi.mock("./install-mode.js", () => installModeMocks);

beforeEach(() => {
  installModeMocks.resolveInstallMode.mockReset();
  installModeMocks.resolveInstallMode.mockImplementation((installMode) =>
    Effect.succeed(installMode ?? WORKSPACE_INSTALL_MODE),
  );
  vi.mocked(createOpenClawAdapter).mockClear();
});

afterEach(() => {
  testbedRuntimeFactoryState.nextRuntime = null;
});

describe("testbed lifecycle", () => {
  it(
    "property: successful testbed launch keeps runtimes alive until stopAll",
    successfulTestbedLaunchKeepsRuntimesUntilStopAll,
  );
  it(
    "tears down an in-flight runtime when startRuntimeAgent is interrupted",
    startRuntimeAgentInterruptionTearsDownRuntime,
  );
  it(
    "tears down ready and in-flight runtimes when launchTestbed is interrupted mid-startup",
    testbedInterruptionTearsDownStartedAndInFlightRuntimes,
  );
  it(
    "tears down an in-flight testbed when a configured process signal arrives",
    processSignalTearsDownInFlightTestbed,
  );
  it(
    "waits for in-flight teardown when the signal wrapper is interrupted",
    processSignalWrapperInterruptionWaitsForTeardown,
  );
  it(
    "tears down previously started and failing runtimes before testbed launch returns an error",
    testbedLaunchFailureTearsDownStartedAndFailingRuntimes,
  );
});

describe("testbed runtime options", () => {
  it(
    "resolves one install mode and shares it with every adapter",
    testbedSharesOneInstallModeAcrossAdapters,
  );
  it("rejects adapter options from the other runtime kind", () => {
    expectTypeOf<
      RuntimeStartOptionsBase & NanoclawWithOpenClawOptions
    >().not.toMatchTypeOf<RuntimeStartOptions>();
    expectTypeOf<
      RuntimeStartOptionsBase & OpenClawWithNanoclawOptions
    >().not.toMatchTypeOf<RuntimeStartOptions>();
    expectTypeOf<
      TestbedLaunchOptionsBase & NanoclawWithOpenClawOptions
    >().not.toMatchTypeOf<TestbedLaunchOptions>();
    expectTypeOf<
      TestbedLaunchOptionsBase & OpenClawWithNanoclawOptions
    >().not.toMatchTypeOf<TestbedLaunchOptions>();
  });
});

function testbedSharesOneInstallModeAcrossAdapters() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      setMockTestbedRuntimes(first.runtime, second.runtime);

      const testbed = yield* launchTestbed({
        kind: OPENCLAW_KIND,
        openclaw: { installMode: PUBLISHED_INSTALL_MODE },
        server: stubServer(),
        agents: alphaBetaAgentSpecs(),
        readyTimeoutMs: READY_TIMEOUT_MS,
      }).pipe(Effect.orDie);

      expect(installModeMocks.resolveInstallMode).toHaveBeenCalledTimes(1);
      expect(installModeMocks.resolveInstallMode).toHaveBeenCalledWith(
        PUBLISHED_INSTALL_MODE,
      );
      expect(createOpenClawAdapter).toHaveBeenCalledTimes(2);
      for (const [options] of vi.mocked(createOpenClawAdapter).mock.calls) {
        expect(options.installMode).toBe(PUBLISHED_INSTALL_MODE);
      }

      yield* testbed.stopAll();
    }),
  );
}

function successfulTestbedLaunchKeepsRuntimesUntilStopAll() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      setMockTestbedRuntimes(first.runtime, second.runtime);

      const testbed = yield* launchTestbed({
        kind: OPENCLAW_KIND,
        server: stubServer(),
        agents: alphaBetaAgentSpecs(),
        readyTimeoutMs: READY_TIMEOUT_MS,
      }).pipe(Effect.orDie);

      expect(testbed.agents).toEqual([
        { name: ALPHA_AGENT_NAME, agentId: ALPHA_AGENT_ID },
        { name: BETA_AGENT_NAME, agentId: BETA_AGENT_ID },
      ]);
      expect(first.stats.teardownCalls).toBe(0);
      expect(second.stats.teardownCalls).toBe(0);

      yield* testbed.stopAll();
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
      setMockTestbedRuntimes(blocked.runtime);

      const fiber = Effect.runFork(
        startRuntimeAgent({
          kind: OPENCLAW_KIND,
          server: stubServer(),
          agent: stubTestbedAgentSpec(),
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

function testbedInterruptionTearsDownStartedAndInFlightRuntimes() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.never,
      });
      setMockTestbedRuntimes(first.runtime, second.runtime);

      const fiber = Effect.runFork(
        launchTestbed({
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

function processSignalTearsDownInFlightTestbed() {
  return runTest(
    Effect.gen(function* () {
      const first = yield* createMockRuntime({
        readyEffect: Effect.succeed({ _tag: READY_TAG }),
      });
      const second = yield* createMockRuntime({
        readyEffect: Effect.never,
      });
      setMockTestbedRuntimes(first.runtime, second.runtime);

      const fiber = Effect.runFork(
        Effect.either(
          launchTestbedWithProcessSignals({
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
          expect(error).toBeInstanceOf(TestbedStartupInterrupted);
          if (error._tag !== "TestbedStartupInterrupted") {
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

function processSignalWrapperInterruptionWaitsForTeardown() {
  return runTest(
    Effect.gen(function* () {
      const teardownStarted = yield* Deferred.make<void, never>();
      const allowTeardown = yield* Deferred.make<void, never>();
      const teardownFinished = yield* Deferred.make<void, never>();
      const blocked = yield* createMockRuntime({
        readyEffect: Effect.never,
        teardownEffect: Deferred.succeed(teardownStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowTeardown)),
          Effect.zipRight(Deferred.succeed(teardownFinished, undefined)),
          Effect.asVoid,
        ),
      });
      setMockTestbedRuntimes(blocked.runtime);

      const launchFiber = Effect.runFork(
        launchTestbedWithProcessSignals({
          kind: OPENCLAW_KIND,
          server: stubServer(),
          agents: [stubTestbedAgentSpec()],
          readyTimeoutMs: LONG_READY_TIMEOUT_MS,
          signals: [],
        }),
      );

      yield* blocked.waitStarted;
      const interruptFiber = yield* Effect.fork(Fiber.interrupt(launchFiber));
      yield* Deferred.await(teardownStarted);

      expect(Option.isNone(yield* Fiber.poll(interruptFiber))).toBe(true);

      yield* Deferred.succeed(allowTeardown, undefined);
      const launchExit = yield* Fiber.join(interruptFiber);
      yield* Deferred.await(teardownFinished);

      expect(Exit.isInterrupted(launchExit)).toBe(true);
      expect(blocked.stats.teardownCalls).toBe(1);
    }),
  );
}

function testbedLaunchFailureTearsDownStartedAndFailingRuntimes() {
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
      setMockTestbedRuntimes(first.runtime, second.runtime);

      const result = yield* Effect.either(
        launchTestbed({
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

function stubTestbedAgentSpec(
  overrides?: Partial<TestbedAgentSpec>,
): TestbedAgentSpec {
  return {
    agentName: TEST_AGENT_NAME,
    apiKey: TEST_API_KEY,
    agentId: TEST_AGENT_ID,
    serverUrl: TEST_SERVER_URL,
    ...overrides,
  };
}

function alphaBetaAgentSpecs(): ReadonlyArray<TestbedAgentSpec> {
  return [
    stubTestbedAgentSpec({
      agentName: ALPHA_AGENT_NAME,
      agentId: ALPHA_AGENT_ID,
    }),
    stubTestbedAgentSpec({
      agentName: BETA_AGENT_NAME,
      agentId: BETA_AGENT_ID,
    }),
  ];
}

function setMockTestbedRuntimes(...runtimes: ReadonlyArray<Runtime>): void {
  const queue = [...runtimes];
  testbedRuntimeFactoryState.nextRuntime = () => {
    const runtime = queue.shift();
    if (runtime === undefined) {
      throw new Error("No mocked runtime remaining for testbed test");
    }
    return runtime;
  };
}

function createMockRuntime(options: {
  readonly readyEffect: Effect.Effect<ReadyOutcome, never, never>;
  readonly teardownEffect?: Effect.Effect<void, never, never>;
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
        }).pipe(Effect.zipRight(options.teardownEffect ?? Effect.void)),
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
