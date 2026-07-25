/**
 * @file The v0 launcher (contract 1, launch half): per-run server
 * container, per-run identity provisioning, per-agent proxied endpoints,
 * mounts, spawns, and readiness — collection in, addressable collection
 * out. Partial launch tears down already-started members in reverse and
 * fails with the failing agent's error.
 *
 * The server-image contract this launcher launches against (built by
 * `scripts/build-server-image.mjs` from `server-image/`): the image runs
 * `moltzap-server` listening on container port 3000 with open
 * registration and no encryption secret (message content stays
 * volume-readable for the transcript drain), persists its PGlite data
 * directory at `/data/pglite`, which this launcher bind-mounts from the
 * per-run volume directory that backs `ServerHandle.storage`, and exports
 * spans to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, which this launcher
 * points at the run's receiver (`LaunchDeps.otlpEndpoint`).
 */
// safer-arch-ignore no-fat-orchestrator: the launch orchestrator behind run-config.ts's makeLauncher; the wiring breadth (docker, provisioning, adapters, readiness) is contract 1's launch half by design.
import {
  Command,
  FetchHttpClient,
  FileSystem,
  HttpClient,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { networkInterfaces, platform } from "node:os";
import { Deferred, Duration, Effect, type Scope } from "effect";
import {
  ServerUrl as mintServerUrl,
  type RuntimeServerHandle,
} from "../runtime.js";
import { createOpenClawAdapter } from "../openclaw-adapter.js";
import { NanoclawAdapter } from "../nanoclaw-adapter.js";
import { MoltZapAgentClient } from "@moltzap/protocol/socket";
import { AgentPresenceSubscribe } from "@moltzap/protocol/network";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ReadyOutcome, Runtime } from "../runtime.js";
import {
  agentKeyValue,
  httpBaseFromServerUrl,
  registerIdentity,
  type MintedIdentity,
} from "./provisioning.js";
import { makeStubRuntime } from "./stub-runtime.js";
import { resolveStubScript } from "./stub-scripts.js";
import type { Agent, AgentFacingRunSpec } from "./run-spec.js";
import type { MountHandle } from "./environment.js";
import type {
  LaunchDeps,
  LaunchedAgent,
  Launcher,
  ServerHandle,
  SimulatorRuntime,
  Society,
  TeardownReport,
} from "./run-config.js";
import { wallTimeNow } from "./ids.js";
import {
  AgentLaunchFailed,
  ProvisioningFailed,
  ServerLaunchFailed,
  type LoggingProxyFailed,
  type MountFailed,
} from "./errors.js";

/** Port the image's server listens on, and the port this launcher publishes. */
export const SERVER_CONTAINER_PORT = 3000;
/** The image's volume mount point, bind-mounted from the run's storage directory. */
export const SERVER_DATA_MOUNT = "/data";
/** Where under the mount the image's config pins its PGlite data directory. */
export const SERVER_PGLITE_DIR = "pglite";

const SERVER_HEALTH_POLL_MS = 250;
const MOUNT_PROBE_POLL_MS = 250;
const MOUNT_PROBE_ATTEMPTS = 40;
const OBSERVER_IDENTITY = "moltzap-sim-observer";
const PRESENCE_POLL_MS = 500;

type LaunchError =
  | ServerLaunchFailed
  | ProvisioningFailed
  | AgentLaunchFailed
  | MountFailed
  | LoggingProxyFailed;

/** Create the v0 agent runner (Docker server container + shipped adapters + StubRuntime). */
export function makeLauncherLive(): Launcher {
  return { launch };
}

function launch(
  spec: AgentFacingRunSpec,
  deps: LaunchDeps,
): Effect.Effect<Society, LaunchError, Scope.Scope> {
  return Effect.gen(function* () {
    const server = yield* startServerContainer(spec, deps.otlpEndpoint);
    yield* enqueueLifecycle(deps, {
      _tag: "server.started",
      serverUrl: server.handle.serverUrl,
    });
    const observer = yield* provisionObserver(server.handle, deps);
    const society = yield* launchAgents(spec, deps, server, observer);
    yield* Effect.addFinalizer(() => society.teardown().pipe(Effect.asVoid));
    return society;
  }).pipe(Effect.withSpan("Launcher.launch"));
}

function enqueueLifecycle(
  deps: LaunchDeps,
  fields:
    | { readonly _tag: "server.started"; readonly serverUrl: string }
    | {
        readonly _tag: "agent.launched";
        readonly agent: Agent["name"];
        readonly agentId: string;
      }
    | {
        readonly _tag: "agent.ready";
        readonly agent: Agent["name"];
        readonly agentId: string;
      },
): Effect.Effect<void, never, never> {
  return deps.log
    .enqueue({
      ...fields,
      source: "lifecycle",
      wallTime: wallTimeNow(),
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}

// ---------------------------------------------------------------------------
// Server container
// ---------------------------------------------------------------------------

type StartedServer = {
  readonly handle: ServerHandle;
  readonly containerId: string;
};

function serverFailed(imageDigest: string, detail: string): ServerLaunchFailed {
  return new ServerLaunchFailed({
    imageDigest,
    detail,
    message: `The server container did not reach ready: ${detail}. Check the Docker daemon and the pinned image digest.`,
  });
}

/** Run a command, capture stdout, and fail on a non-zero exit. */
function execCapture(
  parts: ReadonlyArray<string>,
): Effect.Effect<string, string, never> {
  const [head, ...rest] = parts;
  if (head === undefined) return Effect.fail("empty command");
  const command = Command.make(head, ...rest);
  return Command.string(command).pipe(
    Effect.mapError((cause) => String(cause)),
    Effect.provide(NodeContext.layer),
  );
}

/** The engine's host alias, defined for the container by `--add-host`. */
const HOST_GATEWAY_NAME = "host.docker.internal";
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Rewrites a loopback hostname to the engine's host alias by URL parse,
 * never raw string replacement (a loopback literal outside the hostname
 * must survive). A receiver bound to a non-loopback host address is
 * already the address the container dials, so it passes through: that is
 * the native-Linux half of the bind strategy on
 * `resolveReceiverBindHost`.
 */
function containerReachableEndpoint(otlpEndpoint: string): string {
  const url = new URL(otlpEndpoint);
  if (url.hostname === LOOPBACK_HOST || url.hostname === "localhost") {
    url.hostname = HOST_GATEWAY_NAME;
  }
  return url.toString();
}

/**
 * Pick the host address whose port the container can reach, given the
 * engine's bridge gateway and the addresses this host actually owns.
 *
 * A VM-backed engine (Docker Desktop, colima, OrbStack) puts the bridge
 * gateway inside the VM, so the host does not own it; there
 * `host.docker.internal` forwards to host loopback and loopback is the
 * correct bind. A native-Linux engine's bridge gateway IS a host address
 * (`docker0`), and there loopback is unreachable from the container while
 * the gateway address is reachable in both directions — binding it is
 * what keeps spans from being dropped with no error.
 */
export function pickReceiverBindHost(
  gateways: ReadonlyArray<string>,
  hostAddresses: ReadonlySet<string>,
): string {
  return (
    gateways.find((gateway) => hostAddresses.has(gateway)) ?? LOOPBACK_HOST
  );
}

function hostAddresses(): ReadonlySet<string> {
  return new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address),
  );
}

// The engine's bridge topology does not change under a running process,
// and every attempt would otherwise pay for the same `docker` call.
let cachedBindHost: string | undefined;

/**
 * Resolve the receiver's bind address for this process. Only a Linux
 * host can own the engine's bridge gateway, so every other host skips
 * the `docker` call and takes loopback; an engine that cannot be
 * interrogated reads the same way, which is the answer for every
 * VM-backed engine.
 */
export function resolveReceiverBindHost(): Effect.Effect<string, never, never> {
  return Effect.suspend(() => {
    if (cachedBindHost !== undefined) return Effect.succeed(cachedBindHost);
    if (platform() !== "linux") return Effect.succeed(LOOPBACK_HOST);
    return execCapture([
      "docker",
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
    ]).pipe(
      Effect.map((output) =>
        pickReceiverBindHost(output.trim().split(/\s+/), hostAddresses()),
      ),
      Effect.orElseSucceed(() => LOOPBACK_HOST),
      Effect.tap((host) =>
        Effect.sync(() => {
          cachedBindHost = host;
        }),
      ),
    );
  });
}

function serverRunArgs(
  digest: string,
  volumePath: string,
  otlpEndpoint: string,
): ReadonlyArray<string> {
  return [
    "docker",
    "run",
    "--detach",
    "--rm",
    "--publish",
    `${LOOPBACK_HOST}:0:${String(SERVER_CONTAINER_PORT)}`,
    "--volume",
    `${volumePath}:${SERVER_DATA_MOUNT}`,
    // The explicit `host-gateway` mapping defines the alias on Linux
    // engines (Docker Desktop resolves it natively); the reachability
    // caveat lives on `containerReachableEndpoint`.
    "--add-host",
    `${HOST_GATEWAY_NAME}:host-gateway`,
    "--env",
    `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${containerReachableEndpoint(otlpEndpoint)}`,
    digest,
  ];
}

function startServerContainer(
  spec: AgentFacingRunSpec,
  otlpEndpoint: string,
): Effect.Effect<StartedServer, ServerLaunchFailed, Scope.Scope> {
  const digest = spec.server.imageDigest;
  return Effect.gen(function* () {
    const volumePath = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs.makeTempDirectory({ prefix: "moltzap-sim-server-" }),
      ),
      Effect.provide(NodeContext.layer),
      Effect.mapError((cause) =>
        serverFailed(digest, `volume directory: ${String(cause)}`),
      ),
    );
    const containerId = yield* execCapture(
      serverRunArgs(digest, volumePath, otlpEndpoint),
    ).pipe(
      Effect.map((output) => output.trim()),
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
    // Backstop only: covers launch-phase failures (no Society exists yet)
    // and crash paths. The ordered stop lives in `Society.teardown()` so
    // the server is stopped before the transcript sweep; by scope close
    // the container is already gone (`--rm`) and this second stop is an
    // ignored no-op.
    yield* Effect.addFinalizer(() =>
      execCapture(["docker", "stop", containerId]).pipe(Effect.ignore),
    );
    const hostPort = yield* resolveHostPort(containerId).pipe(
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
    const serverUrl = mintServerUrl(`ws://${LOOPBACK_HOST}:${hostPort}/ws`);
    yield* awaitServerHealthy(spec, serverUrl).pipe(
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
    yield* verifyStorageMount(digest, volumePath);
    return {
      handle: {
        imageDigest: digest,
        serverUrl,
        storage: { volumePath },
      },
      containerId,
    };
  });
}

/**
 * The server's own writes are the mount check. The image pins its PGlite
 * directory under the mounted volume, so once health answers, that
 * directory is visible on the host side iff the bind mount really shares
 * bytes. An engine that shares only part of the host filesystem (a VM
 * engine whose mounts do not cover the system temp directory, for one)
 * accepts `--volume` and hands the container a private directory
 * instead; without this check the run proceeds and only the transcript
 * drain notices, after the episode is over.
 */
function verifyStorageMount(
  digest: string,
  volumePath: string,
): Effect.Effect<void, ServerLaunchFailed, never> {
  const dataDir = `${volumePath}/${SERVER_PGLITE_DIR}`;
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(dataDir)),
    Effect.provide(NodeContext.layer),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((present) =>
      present
        ? Effect.void
        : Effect.sleep(Duration.millis(MOUNT_PROBE_POLL_MS)).pipe(
            Effect.zipRight(Effect.fail("absent")),
          ),
    ),
    Effect.retry({ times: MOUNT_PROBE_ATTEMPTS }),
    Effect.mapError(() =>
      serverFailed(
        digest,
        `the server's storage directory never appeared at "${dataDir}" although the container is healthy, so the ${SERVER_DATA_MOUNT} bind mount is not shared with this host. Point the run's storage at a directory the container engine shares (engine file-sharing settings), or the transcript drain will find no messages`,
      ),
    ),
  );
}

function resolveHostPort(
  containerId: string,
): Effect.Effect<string, string, never> {
  return execCapture([
    "docker",
    "port",
    containerId,
    `${String(SERVER_CONTAINER_PORT)}/tcp`,
  ]).pipe(
    Effect.flatMap((output) => {
      const port = output.trim().split("\n")[0]?.split(":").at(-1);
      return port === undefined || port.length === 0
        ? Effect.fail(`unparseable docker port output: ${output}`)
        : Effect.succeed(port);
    }),
  );
}

function awaitServerHealthy(
  spec: AgentFacingRunSpec,
  serverUrl: string,
): Effect.Effect<void, string, never> {
  const healthUrl = `${httpBaseFromServerUrl(serverUrl)}/health`;
  const probe = HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(healthUrl)),
    Effect.map((response) => response.status === 200),
    Effect.orElseSucceed(() => false),
    Effect.provide(FetchHttpClient.layer),
  );
  return probe.pipe(
    Effect.flatMap((healthy) =>
      healthy
        ? Effect.void
        : Effect.sleep(Duration.millis(SERVER_HEALTH_POLL_MS)).pipe(
            Effect.zipRight(Effect.fail("not ready")),
          ),
    ),
    Effect.retry({
      times: Math.ceil(spec.timeouts.readyTimeoutMs / SERVER_HEALTH_POLL_MS),
    }),
    Effect.mapError(
      () =>
        `health endpoint did not answer within ${String(spec.timeouts.readyTimeoutMs)}ms`,
    ),
    Effect.asVoid,
  );
}

// ---------------------------------------------------------------------------
// Provisioning + readiness
// ---------------------------------------------------------------------------

type Observer = {
  readonly client: MoltZapAgentClient;
  readonly serverHandle: RuntimeServerHandle;
};

/**
 * The observer credential watches readiness through presence
 * subscriptions; its own protocol traffic never appears as society
 * events (presence calls emit no message spans and no transcripts).
 */
function provisionObserver(
  server: ServerHandle,
  deps: LaunchDeps,
): Effect.Effect<Observer, ProvisioningFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const minted = yield* mint(server, deps, OBSERVER_IDENTITY);
    const client = new MoltZapAgentClient({
      serverUrl: httpBaseFromServerUrl(server.serverUrl),
      agentKey: minted.apiKey,
    });
    yield* client.connect().pipe(Effect.mapError(observerConnectFailed));
    yield* Effect.addFinalizer(() => client.close());
    return {
      client,
      serverHandle: {
        awaitAgentReady: (agentId, timeoutMs) =>
          awaitReadyByPresence(client, agentId, timeoutMs),
      },
    };
  });
}

function observerConnectFailed(cause: unknown): ProvisioningFailed {
  return new ProvisioningFailed({
    subject: OBSERVER_IDENTITY,
    message: `The observer credential could not connect: ${String(cause)}.`,
  });
}

function mint(
  server: ServerHandle,
  deps: LaunchDeps,
  name: string,
): Effect.Effect<MintedIdentity, ProvisioningFailed, never> {
  return registerIdentity({
    httpBase: httpBaseFromServerUrl(server.serverUrl),
    name,
  }).pipe(
    Effect.tap((minted) =>
      Effect.sync(() => {
        deps.secrets.register(agentKeyValue(minted.apiKey));
      }),
    ),
    Effect.catchTag("IdentityRegistrationFailed", (cause) =>
      Effect.fail(
        new ProvisioningFailed({
          subject: name,
          message: `Identity provisioning against the fresh server failed: ${cause.message}`,
        }),
      ),
    ),
  );
}

function awaitReadyByPresence(
  client: MoltZapAgentClient,
  agentId: AgentId,
  timeoutMs: number,
): Effect.Effect<ReadyOutcome, never, never> {
  const tick = client
    .callDefinition(AgentPresenceSubscribe, { agentIds: [agentId] })
    .pipe(
      Effect.map((result) =>
        result.statuses.some(
          (entry) => entry.agentId === agentId && entry.status !== "offline",
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
  const loop: Effect.Effect<ReadyOutcome, never, never> = tick.pipe(
    Effect.flatMap((ready) =>
      ready
        ? Effect.succeed<ReadyOutcome>({ _tag: "Ready" })
        : Effect.sleep(Duration.millis(PRESENCE_POLL_MS)).pipe(
            Effect.zipRight(Effect.suspend(() => loop)),
          ),
    ),
  );
  return loop.pipe(
    Effect.timeoutTo({
      duration: Duration.millis(timeoutMs),
      onSuccess: (outcome): ReadyOutcome => outcome,
      onTimeout: (): ReadyOutcome => ({ _tag: "Timeout", timeoutMs }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function launchAgents(
  spec: AgentFacingRunSpec,
  deps: LaunchDeps,
  server: StartedServer,
  observer: Observer,
): Effect.Effect<Society, LaunchError, Scope.Scope> {
  return Effect.gen(function* () {
    const agents: Array<LaunchedAgent> = [];
    const mounts: Array<MountHandle> = [];
    const teardownState: TeardownOnce = {
      started: false,
      report: yield* Deferred.make<TeardownReport>(),
    };
    const ctx: LaunchContext = { spec, deps, server, observer };
    yield* Effect.forEach(
      spec.agents,
      (agent) =>
        launchOneAgent(ctx, agent).pipe(
          Effect.map((launched) => {
            agents.push(launched.agent);
            mounts.push(launched.mount);
          }),
        ),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.onError(() =>
        teardownAgents(agents).pipe(Effect.zipRight(observer.client.close())),
      ),
    );
    return {
      server: server.handle,
      agents,
      mounts,
      teardown: () =>
        teardownSociety(teardownState, agents, server.containerId),
    };
  });
}

/** Reverse insertion order, mirroring startup; runtime teardown is idempotent. */
function teardownAgents(
  agents: ReadonlyArray<LaunchedAgent>,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    [...agents].reverse(),
    (launched) => launched.runtime.teardown(),
    { concurrency: 1, discard: true },
  );
}

function stopServerContainer(
  containerId: string,
): Effect.Effect<ReadonlyArray<string>, never, never> {
  return execCapture(["docker", "stop", containerId]).pipe(
    Effect.as([] as ReadonlyArray<string>),
    Effect.catchAll((detail) =>
      Effect.succeed([`server-container: ${detail}`] as ReadonlyArray<string>),
    ),
  );
}

type TeardownOnce = {
  started: boolean;
  readonly report: Deferred.Deferred<TeardownReport>;
};

/**
 * The binding shutdown sequence makes "server stopped" a precondition
 * of the post-teardown transcript sweep, so the server container stops
 * here — inside `teardown()`, before the caller sweeps — not in a scope
 * finalizer that would fire after seal. Agents come down in reverse
 * first (runtime teardown is infallible by contract); a failing
 * container stop lands in `failures` and marks the report incomplete.
 * Teardown runs once; later callers await and receive the same report,
 * never a synthetic clean one.
 */
function teardownSociety(
  state: TeardownOnce,
  agents: ReadonlyArray<LaunchedAgent>,
  containerId: string,
): Effect.Effect<TeardownReport, never, never> {
  return Effect.suspend(() => {
    if (state.started) return Deferred.await(state.report);
    state.started = true;
    return teardownAgents(agents).pipe(
      Effect.zipRight(stopServerContainer(containerId)),
      Effect.map(
        (failures): TeardownReport => ({
          complete: failures.length === 0,
          failures,
        }),
      ),
      Effect.tap((report) => Deferred.succeed(state.report, report)),
    );
  });
}

type LaunchedOne = {
  readonly agent: LaunchedAgent;
  readonly mount: MountHandle;
};

type LaunchContext = {
  readonly spec: AgentFacingRunSpec;
  readonly deps: LaunchDeps;
  readonly server: StartedServer;
  readonly observer: Observer;
};

function launchOneAgent(
  ctx: LaunchContext,
  agent: Agent,
): Effect.Effect<LaunchedOne, LaunchError, Scope.Scope> {
  const { spec, deps, server, observer } = ctx;
  return Effect.gen(function* () {
    const minted = yield* mint(server.handle, deps, agent.name);
    const endpoint = yield* deps.world.allocateEndpoint(
      agent.name,
      server.handle.serverUrl,
    );
    const mount = yield* deps.environment.prepare(
      agent,
      deps.log,
      deps.secrets,
    );
    const runtime = yield* runtimeFor(agent, mount, observer);
    yield* spawnAgent(runtime, agent, minted, endpoint);
    // `agent.launched` asserts the runtime process was spawned, so it
    // enqueues only after the spawn succeeds.
    yield* enqueueLifecycle(deps, {
      _tag: "agent.launched",
      agent: agent.name,
      agentId: minted.agentId,
    });
    const ready = yield* runtime.waitUntilReady(spec.timeouts.readyTimeoutMs);
    yield* readyOrFail(agent, ready);
    yield* enqueueLifecycle(deps, {
      _tag: "agent.ready",
      agent: agent.name,
      agentId: minted.agentId,
    });
    return {
      agent: {
        slot: agent.name,
        agentId: minted.agentId,
        runtime,
        serverUrl: endpoint,
      },
      mount,
    };
  });
}

function spawnAgent(
  runtime: SimulatorRuntime,
  agent: Agent,
  minted: MintedIdentity,
  endpoint: LaunchedAgent["serverUrl"],
): Effect.Effect<void, AgentLaunchFailed, never> {
  return runtime
    .spawn({
      agentName: agent.name,
      apiKey: minted.apiKey,
      agentId: minted.agentId,
      serverUrl: endpoint,
      workspaceFiles: agent.workspaceFiles,
      ...(modelIdOf(agent) === undefined ? {} : { modelId: modelIdOf(agent) }),
    })
    .pipe(
      Effect.catchTag("SpawnFailed", (cause) =>
        Effect.fail(agentLaunchFailed(agent, "spawn-failed", cause.message)),
      ),
    );
}

function modelIdOf(agent: Agent): string | undefined {
  return agent.runtime._tag === "stub"
    ? undefined
    : agent.runtime.config.modelId;
}

function agentLaunchFailed(
  agent: Agent,
  cause: AgentLaunchFailed["cause"],
  detail: string,
): AgentLaunchFailed {
  return new AgentLaunchFailed({
    slot: agent.name,
    cause,
    detail,
    message: `Agent "${agent.name}" failed to launch (${cause}): ${detail}`,
  });
}

function readyOrFail(
  agent: Agent,
  ready: ReadyOutcome,
): Effect.Effect<void, AgentLaunchFailed, never> {
  switch (ready._tag) {
    case "Ready":
      return Effect.void;
    case "Timeout":
      return Effect.fail(
        agentLaunchFailed(
          agent,
          "ready-timeout",
          `no authenticated connection within ${String(ready.timeoutMs)}ms`,
        ),
      );
    case "ProcessExited":
      return Effect.fail(
        agentLaunchFailed(
          agent,
          "exited-before-ready",
          `exit code ${String(ready.exitCode)}: ${ready.stderr.slice(-400)}`,
        ),
      );
    default: {
      const exhaustive: never = ready;
      return Effect.dieMessage(
        `unreachable readiness ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Adapter selection per runtime assignment. The OpenClaw container
 * posture (T10) ships with the server-image row: containerizing the
 * OpenClaw gateway is Docker-image work, and this launcher reports it as
 * an unavailable launch path until that row lands.
 */
function runtimeFor(
  agent: Agent,
  mount: MountHandle,
  observer: Observer,
): Effect.Effect<SimulatorRuntime, AgentLaunchFailed, never> {
  const runtime = agent.runtime;
  switch (runtime._tag) {
    case "stub":
      return stubRuntimeFor(runtime.config.script);
    case "openclaw":
      return openclawRuntimeFor(agent, mount, observer);
    case "nanoclaw":
      return Effect.sync(() =>
        withExit(
          new NanoclawAdapter({
            server: observer.serverHandle,
            autoRegisterConversations: runtime.config.autoRegisterConversations,
            mcpServers: mount.plan.proxiedServers,
            ...(runtime.config.modelId === undefined
              ? {}
              : { modelId: runtime.config.modelId }),
          }),
        ),
      );
    default: {
      const exhaustive: never = runtime;
      return Effect.dieMessage(
        `unreachable runtime kind ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function stubRuntimeFor(
  scriptName: string,
): Effect.Effect<SimulatorRuntime, AgentLaunchFailed, never> {
  // Materialization checked registration; a miss here is a defect.
  const script = resolveStubScript(scriptName);
  if (script === undefined) {
    return Effect.dieMessage(
      `unregistered stub script "${scriptName}" escaped materialization`,
    );
  }
  return Effect.succeed(makeStubRuntime({ script }));
}

function openclawRuntimeFor(
  agent: Agent,
  mount: MountHandle,
  observer: Observer,
): Effect.Effect<SimulatorRuntime, AgentLaunchFailed, never> {
  if (agent.runtime._tag !== "openclaw") {
    return Effect.dieMessage(
      "openclawRuntimeFor requires an openclaw assignment",
    );
  }
  if (agent.runsIn === "container") {
    return Effect.fail(
      agentLaunchFailed(
        agent,
        "spawn-failed",
        "the OpenClaw container launch path ships with the server-image row; use runsIn: host for OpenClaw until it lands",
      ),
    );
  }
  const config = agent.runtime.config;
  return Effect.sync(() =>
    withExit(
      createOpenClawAdapter({
        server: observer.serverHandle,
        ...(config.openclawBin === undefined
          ? {}
          : { openclawBin: config.openclawBin }),
        mcpServers: mount.plan.proxiedServers,
      }),
    ),
  );
}

/** Both shipped adapters implement `awaitExit`; this narrows the existing `Runtime` to the simulator contract. */
function withExit(
  runtime: Runtime & Pick<SimulatorRuntime, "awaitExit">,
): SimulatorRuntime {
  return runtime;
}
