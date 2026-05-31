import type { Signal } from "@effect/platform/CommandExecutor";
import { describe, it, expect, vi } from "vitest";
import { Effect, Either, Fiber, Scope } from "effect";

import {
  OpenClawAdapter,
  type OpenClawAdapterDeps,
} from "./openclaw-adapter.js";
import {
  NanoclawAdapter,
  type NanoclawAdapterDeps,
} from "./nanoclaw-adapter.js";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterDeps,
} from "./claude-code-adapter.js";
import {
  AgentName,
  ApiKey,
  ServerUrl,
  type Runtime,
  type RuntimeServerHandle,
  type SpawnInput,
  type LogSlice,
  type ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";

const LOG_OFFSET = 100;
const TEARDOWN_TIMER_ADVANCE_MS = 15_000;
const READY_TIMEOUT_MS = 1_000;
const FUNCTION_TYPE = "function";
const STRING_TYPE = "string";
const INBOUND_MARKER = "inbound from agent:";
const READY_TAG = "Ready";
const TIMEOUT_TAG = "Timeout";
const PROCESS_EXITED_TAG = "ProcessExited";
const READY_LABEL = "ready";
const MATCH_TIMEOUT_MS = 5_000;
const TIMEOUT_MATCH_RESULT = `timeout:${MATCH_TIMEOUT_MS}`;
const PROCESS_EXIT_MATCH_RESULT = "exit:null";
const TEST_AGENT_NAME = "test-agent";
const TEST_API_KEY = "test-api-key";
const TEST_AGENT_ID = "agent-001";
const TEST_SERVER_URL = "ws://localhost:9999/ws";
const ALICE_AGENT_NAME = "alice";
const ALICE_API_KEY = "sk-abc";
const SPAWN_FAILED_MESSAGE = "ENOENT";
const SIGTERM_SIGNAL = "SIGTERM";
const SIGKILL_SIGNAL = "SIGKILL";
const TEARDOWN_STATE_DIR = "openclaw-teardown-test";
const EXPECTED_READY_OUTCOME_TAGS = [
  READY_TAG,
  TIMEOUT_TAG,
  PROCESS_EXITED_TAG,
] as const;
const RUNTIME_METHODS = [
  "spawn",
  "waitUntilReady",
  "teardown",
  "getLogs",
  "getInboundMarker",
] as const satisfies ReadonlyArray<keyof Runtime>;

// Minimal stub for the live server surface the adapters poll for readiness.
// `awaitAgentReady` returns `Effect.never` to model "agent never authenticates" —
// adapters under test either short-circuit on no-spawn or rely on their own
// process-exit detector to resolve the race.
function stubServer(): RuntimeServerHandle {
  return {
    awaitAgentReady: (_agentId: string, _timeoutMs: number) => Effect.never,
  };
}

function stubDeps(): OpenClawAdapterDeps {
  return {
    server: stubServer(),
    openclawBin: "/bin/false",
    channelDistDir: "/nonexistent/channel",
    repoRoot: "/nonexistent/repo",
  };
}

function stubSpawnInput(overrides?: Partial<SpawnInput>): SpawnInput {
  return {
    agentName: AgentName(TEST_AGENT_NAME),
    apiKey: ApiKey(TEST_API_KEY),
    agentId: TEST_AGENT_ID,
    serverUrl: ServerUrl(TEST_SERVER_URL),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Runtime interface contract
// ---------------------------------------------------------------------------

describe("Runtime interface", () => {
  it(
    "OpenClawAdapter satisfies the Runtime interface (structural typing)",
    openClawAdapterSatisfiesRuntimeInterface,
  );
  it(
    "exposes exactly the five Runtime interface methods publicly",
    openClawAdapterExposesRuntimeMethods,
  );
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — spawn
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.spawn", () => {
  it(
    "fails with SpawnFailed when bin does not exist",
    openClawSpawnFailsWhenBinDoesNotExist,
  );
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — getLogs / getInboundMarker (no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.getLogs", () => {
  it("returns empty slice when no process has been spawned", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("returns empty slice for non-zero offset when no process has been spawned", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const slice: LogSlice = adapter.getLogs(LOG_OFFSET);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });
});

describe("OpenClawAdapter.getInboundMarker", () => {
  it("returns a non-empty string", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe(STRING_TYPE);
    expect(marker.length).toBeGreaterThan(0);
  });

  it("returns the expected openclaw-channel inbound log prefix", () => {
    const adapter = new OpenClawAdapter(stubDeps());
    expect(adapter.getInboundMarker()).toBe(INBOUND_MARKER);
  });
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — teardown (idempotent, no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.teardown", () => {
  it(
    "completes without error when no process has been spawned",
    openClawTeardownWithoutSpawnCompletes,
  );
  it(
    "is idempotent — calling twice has same effect as once",
    openClawTeardownIsIdempotent,
  );
  it(
    "sends SIGTERM then SIGKILL when the process does not exit",
    openClawTeardownSendsTerminateThenKill,
  );
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — waitUntilReady (no spawn)
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.waitUntilReady", () => {
  it(
    "returns Ready when no process has been spawned",
    openClawWaitUntilReadyReturnsReadyWithoutSpawn,
  );
});

// ---------------------------------------------------------------------------
// ReadyOutcome discriminated union exhaustiveness
// ---------------------------------------------------------------------------

describe("ReadyOutcome", () => {
  it("all variants are distinguishable by _tag", () => {
    const outcomes: ReadyOutcome[] = [
      { _tag: READY_TAG },
      { _tag: TIMEOUT_TAG, timeoutMs: 60000 },
      { _tag: PROCESS_EXITED_TAG, exitCode: 1, stderr: "err" },
    ];

    const tags = outcomes.map((o) => o._tag);
    expect(tags).toEqual(EXPECTED_READY_OUTCOME_TAGS);
  });

  it("switch over ReadyOutcome is exhaustive with absurd", () => {
    function matchOutcome(o: ReadyOutcome): string {
      switch (o._tag) {
        case READY_TAG:
          return READY_LABEL;
        case TIMEOUT_TAG:
          return `timeout:${o.timeoutMs}`;
        case PROCESS_EXITED_TAG:
          return `exit:${o.exitCode}`;
        default:
          return absurd(o);
      }
    }

    expect(matchOutcome({ _tag: READY_TAG })).toBe(READY_LABEL);
    expect(
      matchOutcome({ _tag: TIMEOUT_TAG, timeoutMs: MATCH_TIMEOUT_MS }),
    ).toBe(TIMEOUT_MATCH_RESULT);
    expect(
      matchOutcome({ _tag: PROCESS_EXITED_TAG, exitCode: null, stderr: "" }),
    ).toBe(PROCESS_EXIT_MATCH_RESULT);
  });
});

// ---------------------------------------------------------------------------
// Branded types — compile-time contract verification
// ---------------------------------------------------------------------------

describe("branded types", () => {
  it("AgentName brand compiles and round-trips", () => {
    const name = AgentName(ALICE_AGENT_NAME);
    expect(name).toBe(ALICE_AGENT_NAME);
  });

  it("ApiKey brand compiles and round-trips", () => {
    const key = ApiKey(ALICE_API_KEY);
    expect(key).toBe(ALICE_API_KEY);
  });

  it("ServerUrl brand compiles and round-trips", () => {
    const url = ServerUrl(TEST_SERVER_URL);
    expect(url).toBe(TEST_SERVER_URL);
  });
});

// ---------------------------------------------------------------------------
// SpawnFailed error tag
// ---------------------------------------------------------------------------

describe("SpawnFailed", () => {
  it("carries agentName and cause", () => {
    const cause = new Error(SPAWN_FAILED_MESSAGE);
    const err = new SpawnFailed({
      agentName: ALICE_AGENT_NAME,
      cause,
      message: `Failed to spawn agent "${ALICE_AGENT_NAME}": ${cause.message}`,
    });
    expect(err).toBeInstanceOf(SpawnFailed);
    expect(err.agentName).toBe(ALICE_AGENT_NAME);
    expect(err.cause).toBe(cause);
  });
});

// ---------------------------------------------------------------------------
// NanoclawAdapter — interface contract
// ---------------------------------------------------------------------------

function stubNanoclawDeps(): NanoclawAdapterDeps {
  return { server: stubServer() };
}

describe("NanoclawAdapter", () => {
  it("satisfies the Runtime interface (structural typing)", () => {
    const adapter: Runtime = new NanoclawAdapter(stubNanoclawDeps());
    expectRuntimeMethods(adapter);
  });

  it("getLogs returns empty slice when not spawned", () => {
    const adapter = new NanoclawAdapter(stubNanoclawDeps());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("getInboundMarker returns non-empty string", () => {
    const adapter = new NanoclawAdapter(stubNanoclawDeps());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe(STRING_TYPE);
    expect(marker.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeAdapter — interface contract (issue #255)
//
// Mirror of the OpenClawAdapter unit suite: spawn against a non-existent
// bin yields SpawnFailed, getLogs / getInboundMarker / waitUntilReady /
// teardown all behave deterministically when no process has been spawned.
// ---------------------------------------------------------------------------

function stubClaudeCodeDeps(): ClaudeCodeAdapterDeps {
  return {
    server: stubServer(),
    claudeBin: "/bin/false",
    channelDistDir: "/nonexistent/cc-channel/dist",
    repoRoot: "/nonexistent/repo",
  };
}

describe("ClaudeCodeAdapter", () => {
  it("satisfies the Runtime interface (structural typing)", () => {
    const adapter: Runtime = new ClaudeCodeAdapter(stubClaudeCodeDeps());
    expectRuntimeMethods(adapter);
  });

  it(
    "property: Runtime method contracts match the other adapters",
    claudeCodeAdapterMatchesRuntimeMethodContract,
  );

  it("getLogs returns empty slice when not spawned", () => {
    const adapter = new ClaudeCodeAdapter(stubClaudeCodeDeps());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("getInboundMarker returns non-empty string", () => {
    const adapter = new ClaudeCodeAdapter(stubClaudeCodeDeps());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe(STRING_TYPE);
    expect(marker.length).toBeGreaterThan(0);
  });

  it(
    "waitUntilReady returns Ready when no process has been spawned",
    claudeCodeWaitUntilReadyReturnsReadyWithoutSpawn,
  );
  it(
    "teardown is idempotent when no process has been spawned",
    claudeCodeTeardownIsIdempotent,
  );
  it(
    "spawn fails with SpawnFailed when the channel dist dir does not exist",
    claudeCodeSpawnFailsWhenChannelDistDirIsMissing,
  );
});

// ---------------------------------------------------------------------------
// Test bodies
// ---------------------------------------------------------------------------

function openClawAdapterSatisfiesRuntimeInterface(): void {
  const adapter: Runtime = new OpenClawAdapter(stubDeps());
  expectRuntimeMethods(adapter);
}

function openClawAdapterExposesRuntimeMethods(): void {
  const adapter = new OpenClawAdapter(stubDeps());
  const publicMethods = RUNTIME_METHODS.filter((method) => method in adapter);
  expect(publicMethods).toEqual(RUNTIME_METHODS);
  expectRuntimeMethods(adapter);
}

function openClawSpawnFailsWhenBinDoesNotExist() {
  return runTest(
    Effect.gen(function* () {
      const adapter = new OpenClawAdapter(stubDeps());
      const result = yield* Effect.either(adapter.spawn(stubSpawnInput()));

      Either.match(result, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(SpawnFailed);
          expect(error.agentName).toBe(TEST_AGENT_NAME);
          expect(error.cause).toBeInstanceOf(Error);
        },
        onRight: () => expect.fail(),
      });
    }),
  );
}

function openClawTeardownWithoutSpawnCompletes() {
  const adapter = new OpenClawAdapter(stubDeps());
  return expect(Effect.runPromise(adapter.teardown())).resolves.toBeUndefined();
}

function openClawTeardownIsIdempotent() {
  const adapter = new OpenClawAdapter(stubDeps());
  return expect(
    Effect.runPromise(
      adapter.teardown().pipe(Effect.zipRight(adapter.teardown())),
    ),
  ).resolves.toBeUndefined();
}

function openClawTeardownSendsTerminateThenKill() {
  return runTest(
    Effect.gen(function* () {
      vi.useFakeTimers();
      const killCalls: Signal[] = [];
      const scope = yield* Scope.make();
      const exitFiber = yield* Effect.fork(
        Effect.never as Effect.Effect<number, never, never>,
      );

      const adapter = new OpenClawAdapter(stubDeps());
      injectOpenClawAdapterState(adapter, {
        process: {
          exitFiber,
          kill: (signal: Signal) =>
            Effect.sync(() => {
              killCalls.push(signal);
            }),
          scope,
        },
        stateDir: TEARDOWN_STATE_DIR,
        logBuffer: { value: "" },
        spawnInput: stubSpawnInput(),
        tornDown: false,
      });

      try {
        const teardownPromise = Effect.runPromise(adapter.teardown());
        yield* Effect.tryPromise({
          try: () => vi.advanceTimersByTimeAsync(TEARDOWN_TIMER_ADVANCE_MS),
          catch: (cause) => cause,
        }).pipe(Effect.orDie);
        yield* Effect.tryPromise({
          try: () => teardownPromise,
          catch: (cause) => cause,
        }).pipe(Effect.orDie);
      } finally {
        vi.useRealTimers();
        yield* Fiber.interrupt(exitFiber);
      }

      expect(killCalls).toEqual([SIGTERM_SIGNAL, SIGKILL_SIGNAL]);
    }),
  );
}

function openClawWaitUntilReadyReturnsReadyWithoutSpawn() {
  return runTest(
    Effect.gen(function* () {
      const adapter = new OpenClawAdapter(stubDeps());
      const outcome: ReadyOutcome =
        yield* adapter.waitUntilReady(READY_TIMEOUT_MS);
      expect(outcome._tag).toBe(READY_TAG);
    }),
  );
}

function claudeCodeAdapterMatchesRuntimeMethodContract(): void {
  const adapters: ReadonlyArray<Runtime> = [
    new OpenClawAdapter(stubDeps()),
    new NanoclawAdapter(stubNanoclawDeps()),
    new ClaudeCodeAdapter(stubClaudeCodeDeps()),
  ];

  for (const adapter of adapters) {
    expectRuntimeMethods(adapter);
  }
}

function claudeCodeWaitUntilReadyReturnsReadyWithoutSpawn() {
  return runTest(
    Effect.gen(function* () {
      const adapter = new ClaudeCodeAdapter(stubClaudeCodeDeps());
      const outcome: ReadyOutcome =
        yield* adapter.waitUntilReady(READY_TIMEOUT_MS);
      expect(outcome._tag).toBe(READY_TAG);
    }),
  );
}

function claudeCodeTeardownIsIdempotent() {
  const adapter = new ClaudeCodeAdapter(stubClaudeCodeDeps());
  return expect(
    Effect.runPromise(
      adapter.teardown().pipe(Effect.zipRight(adapter.teardown())),
    ),
  ).resolves.toBeUndefined();
}

function claudeCodeSpawnFailsWhenChannelDistDirIsMissing() {
  return runTest(
    Effect.gen(function* () {
      const adapter = new ClaudeCodeAdapter(stubClaudeCodeDeps());
      const result = yield* Effect.either(adapter.spawn(stubSpawnInput()));

      Either.match(result, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(SpawnFailed);
          expect(error.agentName).toBe(TEST_AGENT_NAME);
        },
        onRight: () => expect.fail(),
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectedOpenClawAdapterState {
  readonly process: {
    readonly exitFiber: Fiber.RuntimeFiber<number, never>;
    readonly kill: (signal: Signal) => Effect.Effect<void, never, never>;
    readonly scope: Scope.CloseableScope;
  };
  readonly stateDir: string;
  readonly logBuffer: { readonly value: string };
  readonly spawnInput: SpawnInput;
  tornDown: boolean;
}

// `OpenClawAdapter.state` is private; teardown is the only path that reads it.
// `Reflect.set` writes the field without a privacy-defeating cast. The injected
// process omits `proc` because the teardown path under test never reads it.
function injectOpenClawAdapterState(
  adapter: OpenClawAdapter,
  state: InjectedOpenClawAdapterState,
): void {
  Reflect.set(adapter, "state", state);
}

function runTest<A>(effect: Effect.Effect<A, never, never>) {
  return Effect.runPromise(effect);
}

function expectRuntimeMethods(adapter: Runtime): void {
  for (const method of RUNTIME_METHODS) {
    expect(typeof adapter[method]).toBe(FUNCTION_TYPE);
  }
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
