import { FileSystem, Path } from "@effect/platform";
import type { Signal } from "@effect/platform/CommandExecutor";
import { NodeContext } from "@effect/platform-node";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Option,
  Redacted,
  Scope,
} from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";

import {
  assertWorkspaceChannelDist,
  buildOpenClawConfig,
  createOpenClawAdapter,
  OpenClawAdapter,
  type OpenClawAdapterDeps,
} from "./openclaw-adapter.js";
import { TESTBED_PROFILE_NAME } from "./channel-plugin-install.js";
import { BoundedLogBuffer } from "./child-process.js";
import {
  NanoclawAdapter,
  type NanoclawAdapterOptions,
} from "./nanoclaw-adapter.js";
import {
  AgentName,
  type LogSlice,
  type ReadyOutcome,
  type Runtime,
  type RuntimeServerHandle,
  ServerUrl,
  type SpawnInput,
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
const WORKSPACE_INSTALL_MODE = "workspace";
const PUBLISHED_INSTALL_MODE = "published";
const TEST_AGENT_NAME = "test-agent";
const TEST_STATE_DIR_PREFIX = `openclaw-${TEST_AGENT_NAME}-`;
const PROCESS_SPAWN_AGENT_NAME = "process-spawn-agent";
const TEST_API_KEY = redactedAgentKey(agentKeyString(70));
const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const TEST_SERVER_URL = "ws://localhost:9999/ws";
const TEST_SERVER_BASE_URL = "ws://localhost:9999";
const ALICE_AGENT_NAME = "alice";
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
    awaitAgentReady: (_agentId, _timeoutMs: number) => Effect.never,
  };
}

function stubDeps(): OpenClawAdapterDeps {
  return {
    server: stubServer(),
    openclawBin: "/bin/false",
    channelDistDir: "/nonexistent/channel",
    installMode: WORKSPACE_INSTALL_MODE,
  };
}

function stubSpawnInput(overrides?: Partial<SpawnInput>): SpawnInput {
  return {
    agentName: AgentName(TEST_AGENT_NAME),
    apiKey: TEST_API_KEY,
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
// Installed-package factory
// ---------------------------------------------------------------------------

describe("createOpenClawAdapter", () => {
  it(
    "uses explicit paths without workspace discovery",
    openClawFactoryUsesExplicitPaths,
  );
  it("resolves pinned installed defaults", openClawFactoryResolvesDefaults);
  it(
    "rejects an installed channel artifact in workspace mode",
    openClawWorkspaceModeRejectsInstalledChannel,
  );
});

// ---------------------------------------------------------------------------
// OpenClawAdapter — spawn
// ---------------------------------------------------------------------------

describe("OpenClawAdapter.spawn", () => {
  it(
    "fails with SpawnFailed and cleans state when plugin install fails",
    openClawSpawnFailureCleansState,
  );
  it(
    "cleans prepared state when process spawn fails",
    openClawProcessSpawnFailureCleansState,
  );
});

// The channel plugin selects its credential profile by account id, so the
// openclaw.json account must be keyed under the same constant the profile
// serializer writes.
const CONFIG_WORKSPACE_DIR = "/workspaces/testbed-agent";
const CUSTOM_MODEL_ID = "custom/model";
const DISABLED_MDNS_MODE = "off";
const OPENCLAW_EXTENSION_NAME = "openclaw-channel";

// @agent-code-guard/regression-only: each example pins one independent OpenClaw configuration contract
describe("buildOpenClawConfig", () => {
  it("keys the moltzap account under the testbed profile", () => {
    const config = buildOpenClawConfig(
      { agentName: "alice", installMode: WORKSPACE_INSTALL_MODE },
      CONFIG_WORKSPACE_DIR,
    );

    expect(config.channels).toMatchObject({
      moltzap: {
        accounts: [{ id: TESTBED_PROFILE_NAME, agentName: "alice" }],
      },
    });
    expect(config.agents).toMatchObject({
      defaults: {
        workspace: CONFIG_WORKSPACE_DIR,
        model: { primary: expect.any(String) },
      },
    });
    expect(config.plugins?.allow).toEqual([OPENCLAW_EXTENSION_NAME]);
  });

  it("prefers an explicit model id over the default", () => {
    const config = buildOpenClawConfig(
      {
        agentName: "alice",
        modelId: CUSTOM_MODEL_ID,
        installMode: WORKSPACE_INSTALL_MODE,
      },
      CONFIG_WORKSPACE_DIR,
    );
    expect(config.agents).toMatchObject({
      defaults: { model: { primary: CUSTOM_MODEL_ID } },
    });
  });

  it("disables mDNS discovery for colocated gateways", () => {
    const config = buildOpenClawConfig(
      { agentName: "alice", installMode: WORKSPACE_INSTALL_MODE },
      CONFIG_WORKSPACE_DIR,
    );

    expect(config.discovery?.mdns?.mode).toBe(DISABLED_MDNS_MODE);
  });

  it("omits local plugin trust for registry-backed installs", () => {
    const config = buildOpenClawConfig(
      { agentName: "alice", installMode: PUBLISHED_INSTALL_MODE },
      CONFIG_WORKSPACE_DIR,
    );

    expect(config).not.toHaveProperty("plugins");
  });
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
  it(
    "sends SIGKILL to the process group after the leader exits",
    openClawTeardownKillsDescendantsAfterLeaderExit,
  );
  it(
    "performs only descendant cleanup when the leader already exited",
    openClawTeardownKillsDescendantsAfterPreexistingLeaderExit,
  );
  it(
    "finishes process-scope cleanup when teardown is interrupted",
    openClawTeardownInterruptionFinishesCleanup,
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

  it("AgentKey redacted value compiles and round-trips", () => {
    expect(Redacted.value(TEST_API_KEY)).toBe(agentKeyString(70));
  });

  it("ServerUrl is the protocol's path-free base constructor", () => {
    expect(ServerUrl(TEST_SERVER_URL)).toBe(TEST_SERVER_BASE_URL);
    expect(() => ServerUrl(`${TEST_SERVER_BASE_URL}/elsewhere`)).toThrow();
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

function stubNanoclawOptions(): NanoclawAdapterOptions {
  return { server: stubServer(), installMode: WORKSPACE_INSTALL_MODE };
}

describe("NanoclawAdapter", () => {
  it("satisfies the Runtime interface (structural typing)", () => {
    const adapter: Runtime = new NanoclawAdapter(stubNanoclawOptions());
    expectRuntimeMethods(adapter);
  });

  it("getLogs returns empty slice when not spawned", () => {
    const adapter = new NanoclawAdapter(stubNanoclawOptions());
    const slice: LogSlice = adapter.getLogs(0);
    expect(slice.text).toBe("");
    expect(slice.nextOffset).toBe(0);
  });

  it("getInboundMarker returns non-empty string", () => {
    const adapter = new NanoclawAdapter(stubNanoclawOptions());
    const marker = adapter.getInboundMarker();
    expect(typeof marker).toBe(STRING_TYPE);
    expect(marker.length).toBeGreaterThan(0);
  });

  it(
    "waitUntilReady returns Ready when no process has been spawned",
    nanoclawWaitUntilReadyReturnsReadyWithoutSpawn,
  );

  it(
    "teardown completes without error when no process has been spawned",
    nanoclawTeardownWithoutSpawnCompletes,
  );

  it(
    "teardown is idempotent — calling twice has same effect as once",
    nanoclawTeardownIsIdempotent,
  );
});

// ---------------------------------------------------------------------------
// Test bodies
// ---------------------------------------------------------------------------

function openClawAdapterSatisfiesRuntimeInterface(): void {
  const adapter: Runtime = new OpenClawAdapter(stubDeps());
  expectRuntimeMethods(adapter);
}

function openClawFactoryUsesExplicitPaths(): void {
  const deps = stubDeps();
  const adapter = createOpenClawAdapter(deps);
  expect(Reflect.get(adapter, "deps")).toEqual(deps);
}

function openClawFactoryResolvesDefaults() {
  return runTest(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) => {
        const adapter = createOpenClawAdapter({
          server: stubServer(),
          installMode: WORKSPACE_INSTALL_MODE,
        });
        const deps = Reflect.get(adapter, "deps") as OpenClawAdapterDeps;
        return Effect.all([
          fileSystem.exists(deps.openclawBin),
          fileSystem.exists(deps.channelDistDir),
        ]);
      }),
      Effect.tap((pathsExist) => {
        expect(pathsExist).toEqual([true, true]);
      }),
      Effect.asVoid,
      Effect.provide(NodeContext.layer),
      Effect.orDie,
    ),
  );
}

function openClawWorkspaceModeRejectsInstalledChannel() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "openclaw-installed-channel-test-",
        });
        const channelDistDir = path.join(
          root,
          "node_modules",
          "@moltzap",
          "openclaw-channel",
          "dist",
        );
        yield* fileSystem.makeDirectory(channelDistDir, { recursive: true });
        const resolvedChannelDistDir =
          yield* fileSystem.realPath(channelDistDir);

        const error = yield* assertWorkspaceChannelDist(channelDistDir).pipe(
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "OpenClawInstallModeError",
          channelDistDir,
          resolvedChannelDistDir,
        });
      }).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
    ),
  );
}

function openClawAdapterExposesRuntimeMethods(): void {
  const adapter = new OpenClawAdapter(stubDeps());
  const publicMethods = RUNTIME_METHODS.filter((method) => method in adapter);
  expect(publicMethods).toEqual(RUNTIME_METHODS);
  expectRuntimeMethods(adapter);
}

function openClawSpawnFailureCleansState() {
  return runTest(
    Effect.gen(function* () {
      const stateDirsBefore = yield* listTestStateDirs();
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

      expect(yield* listTestStateDirs()).toEqual(stateDirsBefore);
    }),
  );
}

function openClawProcessSpawnFailureCleansState() {
  return runTest(
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* createOpenClawSpawnFailureFixture();

        const stateDirsBefore = yield* listTestStateDirs(
          PROCESS_SPAWN_AGENT_NAME,
        );
        const adapter = new OpenClawAdapter({
          server: stubServer(),
          openclawBin: path.join(fixture.root, "missing-openclaw"),
          channelDistDir: fixture.channelDist,
          installMode: WORKSPACE_INSTALL_MODE,
        });
        // The launcher process starts even when the target binary is
        // missing, so spawn commits and the death surfaces through the
        // readiness race — which tears the runtime down.
        const result = yield* Effect.either(
          adapter.spawn(
            stubSpawnInput({
              agentName: AgentName(PROCESS_SPAWN_AGENT_NAME),
            }),
          ),
        );
        yield* Either.match(result, {
          onLeft: (error) =>
            Effect.sync(() => expect(error).toBeInstanceOf(SpawnFailed)),
          onRight: () =>
            adapter
              .waitUntilReady(READY_TIMEOUT_MS)
              .pipe(
                Effect.map((outcome) =>
                  expect(outcome._tag).toBe(PROCESS_EXITED_TAG),
                ),
              ),
        });
        expect(yield* listTestStateDirs(PROCESS_SPAWN_AGENT_NAME)).toEqual(
          stateDirsBefore,
        );
      }),
    ).pipe(Effect.provide(NodeContext.layer), Effect.orDie),
  );
}

function createOpenClawSpawnFailureFixture() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectory({
      prefix: "testbed-openclaw-spawn-fixture-",
    });
    yield* Effect.addFinalizer(() =>
      fileSystem
        .remove(root, { recursive: true, force: true })
        .pipe(Effect.catchAll(() => Effect.void)),
    );

    const channelPackage = path.join(root, "channel");
    const channelDist = path.join(channelPackage, "dist");
    yield* fileSystem.makeDirectory(channelDist, { recursive: true });
    yield* Effect.all([
      fileSystem.writeFileString(
        path.join(channelPackage, "package.json"),
        JSON.stringify({
          name: "testbed-openclaw-spawn-fixture",
          type: "module",
          dependencies: {},
        }),
      ),
      fileSystem.writeFileString(
        path.join(channelDist, "index.js"),
        "export {};\n",
      ),
    ]);
    return { root, channelDist };
  });
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
          // A stubborn process: the kill await never resolves and the exit
          // fiber never completes, so both signal windows must lapse.
          proc: {
            kill: (signal: Signal) =>
              Effect.sync(() => {
                killCalls.push(signal);
              }).pipe(Effect.andThen(Effect.never)),
          },
          scope,
        },
        stateDir: TEARDOWN_STATE_DIR,
        logBuffer: new BoundedLogBuffer(),
        spawnInput: stubSpawnInput(),
        tornDown: false,
      });

      // Cleanup must be Effect.ensuring: a gen-body finally is skipped when
      // a yielded effect fails.
      yield* Effect.gen(function* () {
        const teardownPromise = Effect.runPromise(adapter.teardown());
        yield* Effect.tryPromise({
          try: () => vi.advanceTimersByTimeAsync(TEARDOWN_TIMER_ADVANCE_MS),
          catch: (cause) => cause,
        }).pipe(Effect.orDie);
        yield* Effect.tryPromise({
          try: () => teardownPromise,
          catch: (cause) => cause,
        }).pipe(Effect.orDie);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            vi.useRealTimers();
          }).pipe(Effect.zipRight(Fiber.interrupt(exitFiber))),
        ),
      );

      expect(killCalls).toEqual([SIGTERM_SIGNAL, SIGKILL_SIGNAL]);
    }),
  );
}

function openClawTeardownKillsDescendantsAfterLeaderExit() {
  return runTest(
    Effect.gen(function* () {
      const killCalls: Signal[] = [];
      const scope = yield* Scope.make();
      const exitFiber = yield* Effect.fork(
        Effect.never as Effect.Effect<number, never, never>,
      );

      const adapter = new OpenClawAdapter(stubDeps());
      injectOpenClawAdapterState(adapter, {
        process: {
          exitFiber,
          proc: {
            kill: (signal: Signal) =>
              Effect.sync(() => {
                killCalls.push(signal);
              }).pipe(
                Effect.zipRight(
                  signal === SIGTERM_SIGNAL
                    ? Fiber.interrupt(exitFiber)
                    : Effect.void,
                ),
              ),
          },
          scope,
        },
        stateDir: TEARDOWN_STATE_DIR,
        logBuffer: new BoundedLogBuffer(),
        spawnInput: stubSpawnInput(),
        tornDown: false,
      });

      yield* adapter.teardown();

      expect(killCalls).toEqual([SIGTERM_SIGNAL, SIGKILL_SIGNAL]);
    }),
  );
}

function openClawTeardownKillsDescendantsAfterPreexistingLeaderExit() {
  return runTest(
    Effect.gen(function* () {
      const killCalls: Signal[] = [];
      const scope = yield* Scope.make();
      const exitFiber = yield* Effect.succeed(0).pipe(Effect.fork);
      yield* Fiber.join(exitFiber);

      const adapter = new OpenClawAdapter(stubDeps());
      injectOpenClawAdapterState(adapter, {
        process: {
          exitFiber,
          proc: {
            kill: (signal: Signal) =>
              Effect.sync(() => {
                killCalls.push(signal);
              }),
          },
          scope,
        },
        stateDir: TEARDOWN_STATE_DIR,
        logBuffer: new BoundedLogBuffer(),
        spawnInput: stubSpawnInput(),
        tornDown: false,
      });

      yield* adapter.teardown();

      expect(killCalls).toEqual([SIGKILL_SIGNAL]);
    }),
  );
}

function openClawTeardownInterruptionFinishesCleanup() {
  return runTest(
    Effect.gen(function* () {
      const killStarted = yield* Deferred.make<void, never>();
      const allowKill = yield* Deferred.make<void, never>();
      const scopeClosed = yield* Deferred.make<void, never>();
      const interruptStarted = yield* Deferred.make<void, never>();
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(
        scope,
        Deferred.succeed(scopeClosed, undefined).pipe(Effect.asVoid),
      );
      const exitFiber = yield* Effect.fork(
        Effect.never as Effect.Effect<number, never, never>,
      );

      const adapter = new OpenClawAdapter(stubDeps());
      injectOpenClawAdapterState(adapter, {
        process: {
          exitFiber,
          proc: {
            kill: () =>
              Deferred.succeed(killStarted, undefined).pipe(
                Effect.zipRight(Deferred.await(allowKill)),
                Effect.zipRight(Fiber.interrupt(exitFiber)),
                Effect.asVoid,
              ),
          },
          scope,
        },
        stateDir: TEARDOWN_STATE_DIR,
        logBuffer: new BoundedLogBuffer(),
        spawnInput: stubSpawnInput(),
        tornDown: false,
      });

      const teardownFiber = Effect.runFork(adapter.teardown());
      yield* Deferred.await(killStarted);
      const interruptFiber = yield* Effect.fork(
        Deferred.succeed(interruptStarted, undefined).pipe(
          Effect.zipRight(Fiber.interrupt(teardownFiber)),
        ),
      );
      yield* Deferred.await(interruptStarted);
      yield* Effect.yieldNow();

      expect(Option.isNone(yield* Fiber.poll(interruptFiber))).toBe(true);

      yield* Deferred.succeed(allowKill, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Deferred.await(scopeClosed);
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

function nanoclawWaitUntilReadyReturnsReadyWithoutSpawn() {
  return runTest(
    Effect.gen(function* () {
      const adapter = new NanoclawAdapter(stubNanoclawOptions());
      const outcome: ReadyOutcome =
        yield* adapter.waitUntilReady(READY_TIMEOUT_MS);
      expect(outcome._tag).toBe(READY_TAG);
    }),
  );
}

function nanoclawTeardownWithoutSpawnCompletes() {
  const adapter = new NanoclawAdapter(stubNanoclawOptions());
  return expect(Effect.runPromise(adapter.teardown())).resolves.toBeUndefined();
}

function nanoclawTeardownIsIdempotent() {
  const adapter = new NanoclawAdapter(stubNanoclawOptions());
  return expect(
    Effect.runPromise(
      adapter.teardown().pipe(Effect.zipRight(adapter.teardown())),
    ),
  ).resolves.toBeUndefined();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectedOpenClawAdapterState {
  readonly process: {
    readonly exitFiber: Fiber.RuntimeFiber<number, never>;
    readonly proc: {
      readonly kill: (signal: Signal) => Effect.Effect<void, never, never>;
    };
    readonly scope: Scope.CloseableScope;
  };
  readonly stateDir: string;
  readonly logBuffer: BoundedLogBuffer;
  readonly spawnInput: SpawnInput;
  tornDown: boolean;
}

// `OpenClawAdapter.state` is private; teardown is the only path that reads it.
// `Reflect.set` writes the field without a privacy-defeating cast. The injected
// `proc` carries only `kill` — the sole raw-process member teardown reads.
function injectOpenClawAdapterState(
  adapter: OpenClawAdapter,
  state: InjectedOpenClawAdapterState,
): void {
  Reflect.set(adapter, "state", state);
}

function runTest<A>(effect: Effect.Effect<A, never, never>) {
  return Effect.runPromise(effect);
}

function listTestStateDirs(
  agentName = TEST_AGENT_NAME,
): Effect.Effect<ReadonlyArray<string>, never, never> {
  const prefix =
    agentName === TEST_AGENT_NAME
      ? TEST_STATE_DIR_PREFIX
      : `openclaw-${agentName}-`;
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readDirectory(tmpdir())),
    Effect.map((entries) =>
      entries.filter((entry) => entry.startsWith(prefix)).sort(),
    ),
    Effect.provide(NodeContext.layer),
    Effect.orDie,
  );
}

function expectRuntimeMethods(adapter: Runtime): void {
  for (const method of RUNTIME_METHODS) {
    expect(typeof adapter[method]).toBe(FUNCTION_TYPE);
  }
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
