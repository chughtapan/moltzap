/**
 * @file Shared hermetic-tier fixtures: spec inputs, controllable fake
 * runtimes and launchers, the test transcript drain standing in for the
 * held drain mechanism, and run helpers that execute one attempt with
 * the internal seams injected.
 */
import { Deferred, Effect, Exit, Fiber, Schema, type Scope } from "effect";
import {
  FetchHttpClient,
  FileSystem,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { agentId } from "@moltzap/protocol/testing";
import { ServerUrl } from "../../runtime.js";
import { RunSpec, materializeRunSpec } from "../run-spec.js";
import type { AgentFacingRunSpec } from "../run-spec.js";
import { AttemptId } from "../ids.js";
import { RecordingIdentity, recordingPath } from "../recording.js";
import { decodeEventLine, type SimulatorEvent } from "../event-log.js";
import type {
  LaunchDeps,
  LaunchedAgent,
  Launcher,
  SimulatorRuntime,
  Society,
  TeardownReport,
} from "../run-config.js";
import type { MountHandle } from "../environment.js";
import type { Receiver, TranscriptDrain } from "../event-log.js";
import { makeReceiver } from "../event-log.js";
import { makeLocalRecordingStore } from "../local-store.js";
import {
  runAttempt,
  type RunInternals,
  type RunOptionsInternal,
  type SealedAttemptInternal,
} from "../run-internal.js";
import type { RecordingSnapshot, RecordingStore } from "../recording.js";
import {
  AgentLaunchFailed,
  ServerLaunchFailed,
  type ConfigTimeError,
  type LoggingProxyFailed,
  type ManifestPersistFailed,
  type MountFailed,
  type RecordingStoreFailed,
  type SealFailed,
} from "../errors.js";
import type { Principal, TaskDelivery } from "../episode.js";

export const DONE_SPAN = "test.done";
export const TASK_CONTENT = "seed task: reply when done";
export const PRINCIPAL_NAME = "principal-primary";
export const AGENT_ONE = "agent-one";
export const AGENT_TWO = "agent-two";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const INACTIVITY_MS = 60_000;
const RECEIVER_BOUND_MS = 5_000;

/** Bind host of every hermetic receiver: nothing dials it from a container. */
export const LOOPBACK_BIND_HOST = "127.0.0.1";

/** A valid encoded RunSpec input; overrides merge shallowly per section. */
export function specInput(
  storeRoot: string,
  overrides: Partial<{
    agents: ReadonlyArray<unknown>;
    world: unknown;
    episode: unknown;
    condition: unknown;
    contentVersion: string;
    timeouts: unknown;
    seed: number;
    server: unknown;
  }> = {},
): unknown {
  return {
    seed: overrides.seed ?? 7,
    agents: overrides.agents ?? [
      stubAgentInput(AGENT_ONE),
      stubAgentInput(AGENT_TWO),
    ],
    server: overrides.server ?? { imageDigest: IMAGE_DIGEST },
    episode: overrides.episode ?? {
      task: { principal: PRINCIPAL_NAME, to: AGENT_ONE, content: TASK_CONTENT },
      termination: {
        inactivityTimeoutMs: INACTIVITY_MS,
        onAgentCrash: "halt",
        doneSignal: { name: "span-name", config: { name: DONE_SPAN } },
      },
    },
    ...presentOnly({
      world: overrides.world,
      condition: overrides.condition,
      contentVersion: overrides.contentVersion,
    }),
    timeouts: overrides.timeouts ?? { otlpReceiverFailMs: RECEIVER_BOUND_MS },
    recording: { storeRoot },
  };
}

/** Keeps only defined entries, so optional spec fields stay absent instead of `undefined`. */
function presentOnly(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );
}

export function stubAgentInput(name: string): unknown {
  return {
    name,
    runtime: { _tag: "stub", config: { script: "quiet" } },
    runsIn: "host",
    role: "standard",
  };
}

function decodeSpec(input: unknown): RunSpec {
  return Schema.decodeUnknownSync(RunSpec)(input);
}

export function tempStoreRoot(): Effect.Effect<string, never, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: "sim-store-" })),
    Effect.provide(NodeContext.layer),
    Effect.orDie,
  );
}

// ---------------------------------------------------------------------------
// Fake runtimes and launcher
// ---------------------------------------------------------------------------

type FakeRuntimeControls = {
  readonly runtime: SimulatorRuntime;
  readonly exit: (code: number) => Effect.Effect<void, never, never>;
  readonly teardownOrder: () => ReadonlyArray<string>;
};

function makeFakeRuntime(
  slot: string,
  teardownLog: Array<string>,
): Effect.Effect<FakeRuntimeControls, never, never> {
  return Effect.gen(function* () {
    const exitLatch = yield* Deferred.make<number>();
    const runtime: SimulatorRuntime = {
      spawn: () => Effect.void,
      waitUntilReady: () => Effect.succeed({ _tag: "Ready" }),
      teardown: () =>
        Effect.sync(() => {
          teardownLog.push(slot);
        }),
      getLogs: () => ({ text: "", nextOffset: 0 }),
      getInboundMarker: () => "[fake]",
      awaitExit: () =>
        Deferred.await(exitLatch).pipe(
          Effect.map((exitCode) => ({ exitCode, signal: undefined })),
        ),
    };
    return {
      runtime,
      exit: (code: number) =>
        Deferred.succeed(exitLatch, code).pipe(Effect.asVoid),
      teardownOrder: () => teardownLog,
    };
  }).pipe(Effect.withSpan("makeFakeRuntime"));
}

export type FakeLauncherConfig = {
  /** Slot name whose launch fails after earlier slots started. */
  readonly failAtSlot?: string;
  readonly teardownReport?: TeardownReport;
  /** Fail the launch before any agent starts (server bring-up failure). */
  readonly serverFailure?: boolean;
  /** Server storage volume to hand out; drain paths point this at a prepared PGlite fixture. */
  readonly volumePath?: string;
};

export type FakeLaunch = {
  readonly launcher: Launcher;
  readonly runtimes: Map<string, FakeRuntimeControls>;
  readonly teardownLog: Array<string>;
  readonly capturedDeps: Array<LaunchDeps>;
  readonly capturedSpecs: Array<AgentFacingRunSpec>;
  readonly storageRoots: Array<string>;
};

const FAKE_SERVER_URL = "ws://127.0.0.1:59999/ws";

export function makeFakeLaunch(
  config: FakeLauncherConfig = {},
): Effect.Effect<FakeLaunch, never, never> {
  return Effect.sync(() => {
    const runtimes = new Map<string, FakeRuntimeControls>();
    const teardownLog: Array<string> = [];
    const capturedDeps: Array<LaunchDeps> = [];
    const capturedSpecs: Array<AgentFacingRunSpec> = [];
    const storageRoots: Array<string> = [];
    const launcher: Launcher = {
      launch: (spec, deps) =>
        launchFake(config, spec, deps, {
          runtimes,
          teardownLog,
          capturedDeps,
          capturedSpecs,
          storageRoots,
        }),
    };
    return {
      launcher,
      runtimes,
      teardownLog,
      capturedDeps,
      capturedSpecs,
      storageRoots,
    };
  });
}

type FakeLaunchState = {
  readonly runtimes: Map<string, FakeRuntimeControls>;
  readonly teardownLog: Array<string>;
  readonly capturedDeps: Array<LaunchDeps>;
  readonly capturedSpecs: Array<AgentFacingRunSpec>;
  readonly storageRoots: Array<string>;
};

function launchFake(
  config: FakeLauncherConfig,
  spec: AgentFacingRunSpec,
  deps: LaunchDeps,
  state: FakeLaunchState,
): Effect.Effect<
  Society,
  ServerLaunchFailed | AgentLaunchFailed | MountFailed | LoggingProxyFailed,
  Scope.Scope
> {
  return Effect.gen(function* () {
    state.capturedDeps.push(deps);
    state.capturedSpecs.push(spec);
    // Real launches take time; the delay keeps "scheduled before launch
    // completed" fault fixtures (logical time 0) deterministic.
    yield* Effect.sleep("10 millis");
    if (config.serverFailure === true) {
      return yield* Effect.fail(
        new ServerLaunchFailed({
          imageDigest: spec.server.imageDigest,
          detail: "fake launcher configured to fail server bring-up",
          message: "The server container did not reach ready (fake).",
        }),
      );
    }
    const volumePath = config.volumePath ?? (yield* tempStoreRoot());
    state.storageRoots.push(volumePath);
    const agents: Array<LaunchedAgent> = [];
    const mounts: Array<MountHandle> = [];
    for (const agent of spec.agents) {
      if (agent.name === config.failAtSlot) {
        return yield* failSlot(agents, agent.name);
      }
      const one = yield* startOneFake(deps, state, agent);
      agents.push(one.agent);
      mounts.push(one.mount);
    }
    return fakeSociety(config, spec, state, { volumePath, agents, mounts });
  });
}

function fakeSociety(
  config: FakeLauncherConfig,
  spec: AgentFacingRunSpec,
  state: FakeLaunchState,
  built: {
    readonly volumePath: string;
    readonly agents: ReadonlyArray<LaunchedAgent>;
    readonly mounts: ReadonlyArray<MountHandle>;
  },
): Society {
  const report = config.teardownReport ?? { complete: true, failures: [] };
  return {
    server: {
      imageDigest: spec.server.imageDigest,
      serverUrl: ServerUrl(FAKE_SERVER_URL),
      storage: { volumePath: built.volumePath },
    },
    agents: built.agents,
    mounts: built.mounts,
    teardown: () =>
      Effect.sync(() => {
        for (const started of [...built.agents].reverse()) {
          state.teardownLog.push(`teardown:${started.slot}`);
        }
        return report;
      }),
  };
}

function failSlot(
  started: ReadonlyArray<LaunchedAgent>,
  slot: string,
): Effect.Effect<never, AgentLaunchFailed, never> {
  return Effect.forEach(
    [...started].reverse(),
    (launched) => launched.runtime.teardown(),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.zipRight(
      Effect.fail(
        new AgentLaunchFailed({
          slot,
          cause: "spawn-failed",
          detail: "fake launcher configured to fail this slot",
          message: `Agent "${slot}" failed to launch (fake).`,
        }),
      ),
    ),
  );
}

function startOneFake(
  deps: LaunchDeps,
  state: FakeLaunchState,
  agent: AgentFacingRunSpec["agents"][number],
): Effect.Effect<
  { readonly agent: LaunchedAgent; readonly mount: MountHandle },
  MountFailed | LoggingProxyFailed,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const endpoint = yield* deps.world.allocateEndpoint(
      agent.name,
      ServerUrl(FAKE_SERVER_URL),
    );
    const mount = yield* deps.environment.prepare(
      agent,
      deps.log,
      deps.secrets,
    );
    const controls = yield* makeFakeRuntime(agent.name, state.teardownLog);
    state.runtimes.set(agent.name, controls);
    deps.secrets.register(`key-${agent.name}`);
    return {
      agent: {
        slot: agent.name,
        agentId: agentId(deterministicUuid(agent.name)),
        runtime: controls.runtime,
        serverUrl: endpoint,
      },
      mount,
    };
  });
}

function deterministicUuid(seedText: string): string {
  const hex = [...seedText]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Drain + principal test doubles
// ---------------------------------------------------------------------------

/** Stands in for the held transcript-drain mechanism; sweeps succeed and never fail mid-run. */
export const quietDrain: TranscriptDrain = {
  finalSweep: () => Effect.void,
  awaitFailure: () => Effect.never,
};

export type FakePrincipal = {
  readonly principal: Principal;
  readonly deliveries: ReadonlyArray<TaskDelivery>;
};

/** Captures each delivery; the wire-speaking out-of-band principal is exercised at the nightly tier. */
export function makeFakePrincipal(): FakePrincipal {
  const deliveries: Array<TaskDelivery> = [];
  return {
    principal: {
      deliverTask: (delivery) =>
        Effect.sync(() => {
          deliveries.push(delivery);
        }),
    },
    deliveries,
  };
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

export type RunError =
  | ConfigTimeError
  | RecordingStoreFailed
  | ManifestPersistFailed
  | SealFailed;

export type StartedHermetic = {
  readonly join: Effect.Effect<
    Exit.Exit<SealedAttemptInternal, RunError>,
    never,
    never
  >;
  readonly interrupt: Effect.Effect<void, never, never>;
  readonly launch: FakeLaunch;
  readonly store: RecordingStore;
  readonly principal: FakePrincipal;
  /** Resolves once the run's OTLP receiver is up. */
  readonly endpoint: Effect.Effect<string, never, never>;
};

export type HermeticOptions = {
  readonly launcherConfig?: FakeLauncherConfig;
  readonly internals?: Partial<RunInternals>;
  readonly options?: Omit<RunOptionsInternal, "runner" | "store">;
  readonly store?: RecordingStore;
};

/** Fork one attempt with fake launch + test drain; the real receiver's endpoint is observable. */
export function startHermetic(
  input: unknown,
  storeRoot: string,
  hermetic: HermeticOptions = {},
): Effect.Effect<StartedHermetic, never, never> {
  return Effect.gen(function* () {
    const launch = yield* makeFakeLaunch(hermetic.launcherConfig ?? {});
    const store = hermetic.store ?? makeLocalRecordingStore(storeRoot);
    const endpointLatch = yield* Deferred.make<string>();
    const principal = makeFakePrincipal();
    const internals: RunInternals = {
      makeDrain: () => Effect.succeed(quietDrain),
      // A hermetic run launches no container, so the engine is never asked.
      resolveBindHost: () => Effect.succeed(LOOPBACK_BIND_HOST),
      makeReceiver: (deps) =>
        makeReceiver(deps).pipe(
          Effect.tap((receiver: Receiver) =>
            Deferred.succeed(endpointLatch, receiver.endpoint),
          ),
        ),
      makePrincipal: () => Effect.succeed(principal.principal),
      ...hermetic.internals,
    };
    const fiber = yield* Effect.forkDaemon(
      Effect.exit(
        Effect.scoped(
          runAttempt(
            decodeSpec(input),
            { ...hermetic.options, store, runner: launch.launcher },
            internals,
          ),
        ),
      ),
    );
    return {
      join: Fiber.join(fiber),
      interrupt: Fiber.interrupt(fiber).pipe(Effect.asVoid),
      launch,
      store,
      principal,
      endpoint: Deferred.await(endpointLatch),
    };
  }).pipe(Effect.withSpan("startHermetic"));
}

/** Run one attempt to completion (non-interactive paths). */
export function runHermetic(
  input: unknown,
  storeRoot: string,
  hermetic: HermeticOptions = {},
): Effect.Effect<
  {
    readonly sealedExit: Exit.Exit<SealedAttemptInternal, RunError>;
    readonly launch: FakeLaunch;
    readonly store: RecordingStore;
  },
  never,
  never
> {
  return startHermetic(input, storeRoot, hermetic).pipe(
    Effect.flatMap((started) =>
      started.join.pipe(
        Effect.map((sealedExit) => ({
          sealedExit,
          launch: started.launch,
          store: started.store,
        })),
      ),
    ),
  );
}

const EPISODE_SETTLE_MS = 150;

/**
 * Wait until the episode is observing (launch done plus a settle window;
 * the tap subscription starts with the episode), then post spans.
 */
export function postSpansWhenLive(
  started: StartedHermetic,
  agentCount: number,
  names: ReadonlyArray<string>,
): Effect.Effect<number, never, never> {
  return started.endpoint.pipe(
    Effect.tap(() => awaitAgents(started.launch, agentCount)),
    Effect.tap(() => Effect.sleep(`${EPISODE_SETTLE_MS} millis`)),
    Effect.flatMap((endpoint) => postSpans(endpoint, names)),
  );
}

/** Await the fake launcher having started every expected runtime. */
export function awaitAgents(
  launch: FakeLaunch,
  count: number,
): Effect.Effect<void, never, never> {
  return launch.runtimes.size >= count
    ? Effect.void
    : Effect.sleep("10 millis").pipe(
        Effect.zipRight(Effect.suspend(() => awaitAgents(launch, count))),
      );
}

/** The deterministic path of the given attempt for this spec input. */
export function expectedAttemptPath(
  input: unknown,
  storeRoot: string,
  attempt = "a1",
): Effect.Effect<string, never, never> {
  return materializeRunSpec(input).pipe(
    Effect.map((report) =>
      recordingPath(
        storeRoot,
        new RecordingIdentity({
          specHash: report.specHash,
          seed: report.spec.seed,
        }),
        Schema.decodeSync(AttemptId)(attempt),
      ),
    ),
    Effect.orDie,
  );
}

/** Decode every stored event line back into the event union. */
export function decodedEvents(
  snapshot: RecordingSnapshot,
): Effect.Effect<ReadonlyArray<SimulatorEvent>, never, never> {
  return Effect.forEach(
    snapshot.events,
    (entry) => decodeEventLine(JSON.stringify(entry)),
    { concurrency: 1 },
  ).pipe(Effect.orDie);
}

/** POST one OTLP/HTTP JSON export carrying the named spans. */
export function postSpans(
  endpoint: string,
  names: ReadonlyArray<string>,
): Effect.Effect<number, never, never> {
  const body = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: names.map((name) => ({
              name,
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: "0123456789abcdef",
            })),
          },
        ],
      },
    ],
  };
  return HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((request) => client.execute(request)),
      ),
    ),
    Effect.map((response) => response.status),
    Effect.orElseSucceed(() => 0),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );
}
