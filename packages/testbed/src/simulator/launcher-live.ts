/**
 * @file The v0 launcher (contract 1, launch half): per-run server
 * container, per-run identity provisioning, per-agent proxied endpoints,
 * mounts, spawns, and readiness — collection in, addressable collection
 * out. Partial launch tears down already-started members in reverse and
 * fails with the failing agent's error.
 *
 * The server-image contract this launcher launches against (built by the
 * server-image row): the image runs `moltzap-server` listening on
 * container port 3000 with open registration and no encryption secret
 * (message content stays volume-readable for the transcript drain), and
 * persists its data under `/data`, which this launcher bind-mounts from
 * the per-run volume directory that backs `ServerHandle.storage`.
 * The OTLP export wiring into the container follows the pending
 * `LaunchDeps` endpoint amendment (chughtapan/moltzap#818 thread).
 */
import {
  Command,
  FetchHttpClient,
  FileSystem,
  HttpClient,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Duration, Effect, Schema, type Scope } from "effect";
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
import { WallTimeMs } from "./ids.js";
import {
  AgentLaunchFailed,
  ProvisioningFailed,
  ServerLaunchFailed,
  type LoggingProxyFailed,
  type MountFailed,
} from "./errors.js";

const SERVER_CONTAINER_PORT = 3000;
const SERVER_HEALTH_POLL_MS = 250;
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
    const server = yield* startServerContainer(spec);
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
    | { readonly _tag: "agent.launched"; readonly agent: Agent["name"] }
    | { readonly _tag: "agent.ready"; readonly agent: Agent["name"] },
): Effect.Effect<void, never, never> {
  return deps.log
    .enqueue({
      ...fields,
      source: "lifecycle",
      wallTime: Schema.decodeSync(WallTimeMs)(Date.now()),
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

function startServerContainer(
  spec: AgentFacingRunSpec,
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
    const containerId = yield* execCapture([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--publish",
      `127.0.0.1:0:${String(SERVER_CONTAINER_PORT)}`,
      "--volume",
      `${volumePath}:/data`,
      digest,
    ]).pipe(
      Effect.map((output) => output.trim()),
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
    yield* Effect.addFinalizer(() =>
      execCapture(["docker", "stop", containerId]).pipe(Effect.ignore),
    );
    const hostPort = yield* resolveHostPort(containerId).pipe(
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
    const serverUrl = mintServerUrl(`ws://127.0.0.1:${hostPort}/ws`);
    yield* awaitServerHealthy(spec, serverUrl).pipe(
      Effect.mapError((detail) => serverFailed(digest, detail)),
    );
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
      serverUrl: server.serverUrl,
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
    const torndown = { value: false };
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
      teardown: () => teardownSociety(torndown, agents),
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

function teardownSociety(
  torndown: { value: boolean },
  agents: ReadonlyArray<LaunchedAgent>,
): Effect.Effect<TeardownReport, never, never> {
  if (torndown.value) {
    return Effect.succeed({ complete: true, failures: [] });
  }
  torndown.value = true;
  // Runtime teardown is infallible by contract; the container stop and
  // proxy shutdown run under the launch scope's finalizers. Failures the
  // report can observe land in `failures`.
  return teardownAgents(agents).pipe(
    Effect.as({ complete: true, failures: [] as ReadonlyArray<string> }),
  );
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
    yield* enqueueLifecycle(deps, {
      _tag: "agent.launched",
      agent: agent.name,
    });
    yield* spawnAgent(runtime, agent, minted, endpoint);
    const ready = yield* runtime.waitUntilReady(spec.timeouts.readyTimeoutMs);
    yield* readyOrFail(agent, ready);
    yield* enqueueLifecycle(deps, { _tag: "agent.ready", agent: agent.name });
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
