import { FileSystem, Path } from "@effect/platform";
import type { Signal } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { tmpdir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Option,
  Redacted,
  Schema,
  Scope,
} from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
// The seeding function has no focused plugin-sdk subpath, so the compat bridge
// is the only public surface for it. It drags openclaw's embedded agent runtime
// along, which is seconds of module load; that cost belongs to collection,
// where there is no per-test timeout to blow.
import { ensureAgentWorkspace } from "openclaw/extension-api";
import { OpenClawSchema } from "openclaw/plugin-sdk/config-schema";

import {
  assertWorkspaceChannelDist,
  buildOpenClawConfig,
  buildOpenClawProcessPlan,
  configureOpenClawStateDir,
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
// openclaw treats this file's presence in a workspace as "onboarding pending".
const OPENCLAW_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const OPENCLAW_STATE_DIR_VAR = "OPENCLAW_STATE_DIR";
const OPENCLAW_HOME_VAR = "OPENCLAW_HOME";
const OPENCLAW_WORKSPACE_DIRNAME = "workspace";
const OPENCLAW_SCRATCH_FILENAME = "notes.txt";
// Where openclaw keeps the attestation the adapter's sentinel occupies. The
// blocked arm below asserts this is the path openclaw reads, so a rename here
// or in the adapter's derivation fails rather than passing quietly.
const OPENCLAW_ATTESTATION_DIRNAME = "workspace-attestations";

// openclaw stamps this code on the throw its workspace-vanished guard raises.
const decodeWorkspaceVanished = Schema.decodeUnknown(
  Schema.Struct({ code: Schema.Literal("WORKSPACE_VANISHED") }),
);

type WorkspaceTurn = "ok" | "vanished";

/** What occupies openclaw's attestation path before the turns run. */
type AttestationSentinel = "adapter" | "blocked" | "none";

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

describe("buildOpenClawConfig bootstrap", () => {
  // openclaw's config schema is strict, so a misspelled or misplaced knob is
  // rejected outright rather than carried along as an inert key.
  it("carries skipBootstrap through openclaw's own config schema", () => {
    const parsed = OpenClawSchema.safeParse(
      buildOpenClawConfig(
        { agentName: "alice", installMode: WORKSPACE_INSTALL_MODE },
        CONFIG_WORKSPACE_DIR,
      ),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.agents?.defaults?.skipBootstrap).toBe(true);
  });

  it(
    "leaves openclaw's bootstrap prompt out of a fresh workspace",
    openClawSeedsNoBootstrapPrompt,
  );

  // Without this control the assertion above would hold just as well if
  // openclaw had stopped seeding for a reason that has nothing to do with the
  // config this package writes.
  it(
    "still seeds the prompt when the gate is left open",
    openClawSeedsBootstrapPromptWhenGated,
  );
});

function openClawSeedsNoBootstrapPrompt() {
  const config = buildOpenClawConfig(
    { agentName: "alice", installMode: WORKSPACE_INSTALL_MODE },
    CONFIG_WORKSPACE_DIR,
  );
  return runTest(
    bootstrapPromptSeeded(!config.agents?.defaults?.skipBootstrap).pipe(
      Effect.map((seeded) => {
        expect(seeded).toBe(false);
      }),
    ),
  );
}

function openClawSeedsBootstrapPromptWhenGated() {
  return runTest(
    bootstrapPromptSeeded(true).pipe(
      Effect.map((seeded) => {
        expect(seeded).toBe(true);
      }),
    ),
  );
}

// `ensureBootstrapFiles` is what openclaw's reply path derives from
// `agents.defaults.skipBootstrap` before it prepares a workspace.
function bootstrapPromptSeeded(
  ensureBootstrapFiles: boolean,
): Effect.Effect<boolean, never, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "testbed-openclaw-state-",
      });
      yield* scopedOpenClawStateDir(stateDir);
      const workspaceDir = path.join(stateDir, OPENCLAW_WORKSPACE_DIRNAME);

      yield* Effect.tryPromise(() =>
        ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles }),
      );

      return yield* fileSystem.exists(
        path.join(workspaceDir, OPENCLAW_BOOTSTRAP_FILENAME),
      );
    }),
  ).pipe(Effect.provide(NodeContext.layer), Effect.orDie);
}

// Seeding a workspace writes an attestation next to openclaw's state, which
// defaults to the operator's own `~/.openclaw` and is never cleaned up.
// `OPENCLAW_HOME` moves the legacy state dirs openclaw also consults, so both
// are pointed inside the scoped temp dir and the test leaves nothing behind.
function scopedOpenClawStateDir(
  stateDir: string,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv(OPENCLAW_STATE_DIR_VAR, stateDir);
      vi.stubEnv(OPENCLAW_HOME_VAR, stateDir);
    }),
    () =>
      Effect.sync(() => {
        vi.unstubAllEnvs();
      }),
  );
}

describe("configureOpenClawStateDir attestation sentinel", () => {
  it(
    "keeps openclaw serving turns after an agent empties its own workspace",
    expectWorkspaceTurns("adapter", ["ok", "ok", "ok", "ok"]),
  );

  // The control. Openclaw attests a workspace the moment it holds content, and
  // never withdraws the attestation, so without the sentinel one
  // create-then-delete makes every later turn of the episode throw.
  it(
    "reproduces the guard's permanent throw with no sentinel in place",
    expectWorkspaceTurns("none", ["ok", "ok", "vanished", "vanished"]),
  );

  // The inversion, and the reason the sentinel has to be a directory.
  // `hasRecentWorkspaceAttestation` reads the primary path as attested
  // whenever it fails for anything other than ENOENT, so blocking that path
  // arms the guard on the first turn rather than disarming it.
  it(
    "arms the guard when the attestation path is blocked instead of occupied",
    expectWorkspaceTurns("blocked", ["vanished", "ok", "vanished", "vanished"]),
  );
});

function expectWorkspaceTurns(
  sentinel: AttestationSentinel,
  expected: ReadonlyArray<WorkspaceTurn>,
) {
  return () =>
    runTest(
      workspaceTurnsUnder(sentinel).pipe(
        Effect.map((turns) => {
          expect(turns).toEqual(expected);
        }),
      ),
    );
}

// Drives the real `ensureAgentWorkspace` through the sequence an agent that
// writes a scratch file and later removes it produces, on the gate the adapter
// derives from `skipBootstrap`.
function workspaceTurnsUnder(
  sentinel: AttestationSentinel,
): Effect.Effect<ReadonlyArray<WorkspaceTurn>, never, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "testbed-openclaw-state-",
      });
      yield* scopedOpenClawStateDir(stateDir);
      const workspaceDir = path.join(stateDir, OPENCLAW_WORKSPACE_DIRNAME);
      yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
      yield* applyAttestationSentinel(sentinel, stateDir);

      // A sentinel that landed inside the workspace would be content evidence
      // to openclaw, which suppresses the guard for a reason the turns below
      // cannot tell apart from the sentinel working.
      expect(yield* fileSystem.readDirectory(workspaceDir)).toEqual([]);

      const scratchFile = path.join(workspaceDir, OPENCLAW_SCRATCH_FILENAME);
      const mutations = [
        Effect.void,
        fileSystem.writeFileString(scratchFile, "notes"),
        fileSystem.remove(scratchFile),
        Effect.void,
      ];

      return yield* Effect.forEach(
        mutations,
        (mutate) =>
          mutate.pipe(Effect.zipRight(ensureWorkspaceTurn(workspaceDir))),
        { concurrency: 1 },
      );
    }),
  ).pipe(Effect.provide(NodeContext.layer), Effect.orDie);
}

function applyAttestationSentinel(
  sentinel: AttestationSentinel,
  stateDir: string,
): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  switch (sentinel) {
    case "adapter":
      return configureStateDirThroughAdapter(stateDir);
    case "blocked":
      return configureStateDirThroughAdapter(stateDir).pipe(
        Effect.zipRight(blockOpenClawAttestationPath(stateDir)),
      );
    case "none":
      return Effect.void;
    default:
      return absurd(sentinel);
  }
}

// Entering through the adapter's own state-dir setup is what puts the
// production derivation under test: a sentinel the adapter stops writing, or
// writes at a path openclaw does not read, shows up as a throw below.
function configureStateDirThroughAdapter(
  stateDir: string,
): Effect.Effect<
  void,
  unknown,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return Effect.gen(function* () {
    const fixture = yield* createOpenClawChannelFixture();
    yield* configureOpenClawStateDir(
      { ...stubDeps(), channelDistDir: fixture.channelDist },
      stubSpawnInput(),
      stateDir,
    );
  });
}

// Leaves a file where openclaw expects the directory holding its attestation,
// so every read of that path fails with ENOTDIR rather than ENOENT.
function blockOpenClawAttestationPath(
  stateDir: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attestationDir = path.join(stateDir, OPENCLAW_ATTESTATION_DIRNAME);
    yield* fileSystem.remove(attestationDir, { recursive: true, force: true });
    yield* fileSystem.writeFileString(attestationDir, "");
  });
}

// Openclaw throws its own Error subclass out of `ensureAgentWorkspace`, so the
// code it stamps on the throw is the only contract this test can hold it to.
// Anything else keeps its original error rather than collapsing into a turn
// outcome, so an unrelated failure reports itself instead of the assertion.
function ensureWorkspaceTurn(
  workspaceDir: string,
): Effect.Effect<WorkspaceTurn, unknown, never> {
  return Effect.tryPromise({
    try: () =>
      ensureAgentWorkspace({
        dir: workspaceDir,
        ensureBootstrapFiles: false,
      }),
    catch: (thrown) => thrown,
  }).pipe(
    Effect.as<WorkspaceTurn>("ok"),
    Effect.catchAll((thrown) =>
      decodeWorkspaceVanished(thrown).pipe(
        Effect.as<WorkspaceTurn>("vanished"),
        Effect.orElseFail(() => thrown),
      ),
    ),
  );
}

// The gateway child reads MOLTZAP_SERVER_URL through the moltzap client,
// which appends the `/ws` endpoint path itself.
const OPENCLAW_STATE_DIR = "/state/openclaw-agent";
const OPENCLAW_PORT = 41_234;
const OPENCLAW_BASE_CHILD_ENVIRONMENT = {
  PATH: "/test/bin:/usr/bin:/bin",
  HOME: "/test/home",
};
const SECURE_SERVER_URL = "wss://example.test:8443/ws";
const NORMALIZED_SERVER_URL = "http://localhost:9999";
const NORMALIZED_SECURE_SERVER_URL = "https://example.test:8443";

describe("buildOpenClawProcessPlan", () => {
  it("strips the endpoint path from the child server url", () => {
    const plan = openClawProcessPlan(stubSpawnInput());
    expect(plan.env.MOLTZAP_SERVER_URL).toBe(NORMALIZED_SERVER_URL);
  });

  it("maps a secure endpoint url onto https", () => {
    const plan = openClawProcessPlan(
      stubSpawnInput({ serverUrl: ServerUrl(SECURE_SERVER_URL) }),
    );
    expect(plan.env.MOLTZAP_SERVER_URL).toBe(NORMALIZED_SECURE_SERVER_URL);
  });
});

function openClawProcessPlan(input: SpawnInput) {
  return buildOpenClawProcessPlan({
    openclawBin: stubDeps().openclawBin,
    port: OPENCLAW_PORT,
    stateDir: OPENCLAW_STATE_DIR,
    input,
    baseEnvironment: OPENCLAW_BASE_CHILD_ENVIRONMENT,
  });
}

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
        const fixture = yield* createOpenClawChannelFixture();

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

function createOpenClawChannelFixture() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectory({
      prefix: "testbed-openclaw-channel-fixture-",
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
          name: "testbed-openclaw-channel-fixture",
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
