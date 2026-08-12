/** @file Container-native NanoClaw runtime descriptor. */

import type { AgentName } from "@moltzap/protocol/identity";
import { httpBaseUrl } from "@moltzap/protocol/network";
import { Duration, Effect, Schema, type Scope } from "effect";
import {
  type AgentRuntimeInput,
  type RuntimeAcquisitionError,
  RuntimeFailed,
  type RuntimeTermination,
} from "../agent.js";
import {
  acquisitionFailureFor,
  type Application,
  type ApplicationEndpoint,
  type ContainerAgentRuntime,
  type ContainerRuntime,
  defineContainerRuntime,
  type File,
  image,
  type Image,
  routableBridgeEndpoint,
  stoppedBeforeAttach,
} from "../container.js";
import {
  bootstrapFile,
  type CheckedWorkspaceFile,
  mcpConfiguration,
  type McpServer,
  McpServerConfiguration,
  serializeMoltZapProfileConfig,
  SIMULATOR_PROFILE_NAME,
  snapshotMcpServers,
  snapshotWorkspaceFiles,
  workspaceConfiguration,
  type WorkspaceFile,
  WorkspaceFileConfiguration,
  workspaceFilePath,
} from "../workspace.js";
import {
  acquireDistributedNanoClawGateway,
  type NanoClawGateway,
  type NanoClawGatewaySession,
} from "./gateway.js";

const NANOCLAW_RUNTIME_NAME = "nanoclaw";
const DEFAULT_NANOCLAW_STARTUP_TIMEOUT = Duration.minutes(2);
const NANOCLAW_GATEWAY_PORT = 18_790;
const NANOCLAW_BOOTSTRAP_DIR = "/var/run/moltzap/bootstrap";
const NANOCLAW_CONFIG_PATH = `${NANOCLAW_BOOTSTRAP_DIR}/nanoclaw/runtime.json`;
const NANOCLAW_PROFILE_HOME = `${NANOCLAW_BOOTSTRAP_DIR}/moltzap`;
const NANOCLAW_PROFILE_PATH = `${NANOCLAW_PROFILE_HOME}/config.json`;
const NANOCLAW_WORKSPACE_DIR = `${NANOCLAW_BOOTSTRAP_DIR}/workspace`;
const NANOCLAW_STATE_DIR = "/var/lib/moltzap/nanoclaw";
const NANOCLAW_ENTRYPOINT = "/opt/moltzap/nanoclaw/entrypoint.mjs";
const APPLICATION_RESOURCES = Object.freeze({
  cpuMillis: 1_000,
  memoryBytes: 1_024 * 1_024 * 1_024,
  ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
});

const acquisitionFailure = acquisitionFailureFor(NANOCLAW_RUNTIME_NAME);

/**
 * Sanitized definition-time policy for a NanoClaw application container.
 */
export class NanoClawRuntimeConfiguration extends Schema.Class<NanoClawRuntimeConfiguration>(
  "NanoClawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(WorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  autoRegisterConversations: Schema.Boolean,
  mcpServers: Schema.Array(McpServerConfiguration),
  applicationImage: image,
}) {}

/** Configuration captured by one reusable NanoClaw runtime value. */
export interface NanoClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly WorkspaceFile[];
  readonly modelId?: string;

  /**
   * Digest-pinned one-container NanoClaw artifact for Kubernetes execution.
   */
  readonly applicationImage: Image;

  /**
   * Register conversations on first delivery in disposable evaluations.
   * Ordinary societies leave registration to their endpoint code.
   */
  readonly autoRegisterConversations?: boolean;

  /** MCP servers reachable from the NanoClaw container. */
  readonly mcpServers?: readonly McpServer[];
}

/**
 * Construct a NanoClaw descriptor backed by one application container per
 * roster identity and its runtime-owned native gateway bridge.
 * @param options Options that control the operation.
 * @returns The nanoclaw runtime result.
 */
export function nanoclawRuntime(
  options: NanoClawRuntimeOptions,
): ContainerAgentRuntime<
  NanoClawGateway,
  RuntimeAcquisitionError,
  typeof NanoClawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  const capability = nanoclawCapability(settings, (endpoint, within) =>
    acquireDistributedNanoClawGateway(endpoint.host, endpoint.port, within),
  );
  return defineContainerRuntime({
    name: NANOCLAW_RUNTIME_NAME,
    configuration: {
      schema: NanoClawRuntimeConfiguration,
      value: runtimeConfiguration(settings),
    },
    image: capability.image,
    resources: capability.resources,
    render: capability.render,
  });
}

interface NanoClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly CheckedWorkspaceFile[];
  readonly modelId?: string;
  readonly applicationImage: Image;
  readonly autoRegisterConversations: boolean;
  readonly mcpServers?: readonly McpServer[];
}

type NanoClawGatewayAcquirer = (
  endpoint: ApplicationEndpoint,
  within: Duration.Duration,
) => Effect.Effect<NanoClawGatewaySession, unknown, Scope.Scope>;

interface NanoClawBridge {
  readonly startupTimeout: Duration.Duration;
  readonly agentName: AgentName;
  readonly acquireGateway: NanoClawGatewayAcquirer;
}

interface NanoClawRenderer {
  readonly settings: NanoClawRuntimeSettings;
  readonly acquireGateway: NanoClawGatewayAcquirer;
}

function snapshotOptions(
  options: NanoClawRuntimeOptions,
): NanoClawRuntimeSettings {
  const modelId = options.modelId;
  const mcpServers = snapshotMcpServers(options.mcpServers);
  return Object.freeze({
    startupTimeout: options.startupTimeout ?? DEFAULT_NANOCLAW_STARTUP_TIMEOUT,
    workspaceFiles: snapshotWorkspaceFiles(options.workspaceFiles),
    applicationImage: options.applicationImage,
    autoRegisterConversations: options.autoRegisterConversations ?? false,
    ...(modelId === undefined ? {} : { modelId }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
}

function nanoclawCapability(
  settings: NanoClawRuntimeSettings,
  acquireGateway: NanoClawGatewayAcquirer,
): ContainerRuntime<NanoClawGateway, RuntimeAcquisitionError> {
  const renderer: NanoClawRenderer = { settings, acquireGateway };
  return Object.freeze({
    image: settings.applicationImage,
    resources: APPLICATION_RESOURCES,
    render: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      renderNanoClaw(renderer, input),
  });
}

function runtimeConfiguration(
  settings: NanoClawRuntimeSettings,
): NanoClawRuntimeConfiguration {
  return NanoClawRuntimeConfiguration.make({
    startupTimeout: settings.startupTimeout,
    workspaceFiles: workspaceConfiguration(settings.workspaceFiles),
    autoRegisterConversations: settings.autoRegisterConversations,
    mcpServers: mcpConfiguration(settings.mcpServers),
    applicationImage: settings.applicationImage,
    ...(settings.modelId === undefined
      ? {}
      : { modelOverride: settings.modelId }),
  });
}

function renderNanoClaw<Name extends string>(
  renderer: NanoClawRenderer,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  Application<NanoClawGateway, RuntimeAcquisitionError>,
  RuntimeAcquisitionError
> {
  return Effect.try({
    try: () => makeNanoClawApplication(renderer, input),
    catch: (cause) =>
      acquisitionFailure(
        input.agentName,
        "render distributed application",
        cause,
      ),
  });
}

function makeNanoClawApplication<Name extends string>(
  renderer: NanoClawRenderer,
  input: AgentRuntimeInput<Name>,
): Application<NanoClawGateway, RuntimeAcquisitionError> {
  const { settings } = renderer;
  const bridge = {
    startupTimeout: settings.startupTimeout,
    agentName: input.agentName,
    acquireGateway: renderer.acquireGateway,
  };
  return Object.freeze({
    entrypoint: Object.freeze(["node", NANOCLAW_ENTRYPOINT] as const),
    environment: Object.freeze({
      MOLTZAP_PROFILE: SIMULATOR_PROFILE_NAME,
      MOLTZAP_CONFIG_HOME: NANOCLAW_PROFILE_HOME,
      MOLTZAP_SERVER_URL: httpBaseUrl(input.connection.routerUrl),
      MOLTZAP_NANOCLAW_CONFIG: NANOCLAW_CONFIG_PATH,
      MOLTZAP_NANOCLAW_STATE: NANOCLAW_STATE_DIR,
    }),
    ...(settings.modelId === undefined
      ? {}
      : { credentials: Object.freeze(["ANTHROPIC_API_KEY"] as const) }),
    port: NANOCLAW_GATEWAY_PORT,
    files: bootstrapFiles(settings, input),
    attach: (
      endpoint: ApplicationEndpoint,
      stopped: Effect.Effect<RuntimeTermination>,
      reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
    ) => attachNanoClaw(bridge, endpoint, stopped, reportStopped),
  });
}

function bootstrapFiles<Name extends string>(
  settings: NanoClawRuntimeSettings,
  input: AgentRuntimeInput<Name>,
): readonly File[] {
  const profile = serializeMoltZapProfileConfig({
    agentName: input.agentName,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
  });
  return Object.freeze([
    bootstrapFile(
      NANOCLAW_CONFIG_PATH,
      runtimeConfig(settings, input.agentName),
    ),
    bootstrapFile(NANOCLAW_PROFILE_PATH, profile),
    ...settings.workspaceFiles.map((file) =>
      bootstrapFile(
        workspaceFilePath(NANOCLAW_WORKSPACE_DIR, file.relativePath),
        file.content,
      ),
    ),
  ]);
}

function runtimeConfig(
  settings: NanoClawRuntimeSettings,
  agentName: AgentName,
): string {
  return JSON.stringify(
    {
      apiVersion: "moltzap.nanoclaw-application/v1",
      agentName,
      gateway: {
        host: "0.0.0.0",
        port: NANOCLAW_GATEWAY_PORT,
      },
      stateDirectory: NANOCLAW_STATE_DIR,
      workspaceDirectory: NANOCLAW_WORKSPACE_DIR,
      autoRegisterConversations: settings.autoRegisterConversations,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      mcpServers: settings.mcpServers ?? [],
    },
    null,
    2,
  );
}

function attachNanoClaw(
  bridge: NanoClawBridge,
  endpoint: ApplicationEndpoint,
  stopped: Effect.Effect<RuntimeTermination>,
  reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
): Effect.Effect<NanoClawGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => routableBridgeEndpoint(endpoint),
      catch: (cause) =>
        acquisitionFailure(
          bridge.agentName,
          "resolve distributed gateway",
          cause,
        ),
    });
    const acquire = bridge
      .acquireGateway(target, bridge.startupTimeout)
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(
            bridge.agentName,
            "connect distributed principal gateway",
            cause,
          ),
        ),
      );
    const session = yield* Effect.raceFirst(
      acquire,
      stoppedBeforeBridge(bridge.agentName, stopped),
    );
    yield* observeGatewayLoss(bridge, session, reportStopped);
    return session.gateway;
  });
}

function stoppedBeforeBridge(
  agentName: AgentName,
  stopped: Effect.Effect<RuntimeTermination>,
): Effect.Effect<never, RuntimeAcquisitionError> {
  return stoppedBeforeAttach(stopped, (detail) =>
    acquisitionFailure(
      agentName,
      "connect distributed principal gateway",
      `NanoClaw application stopped before its bridge was ready: ${detail}`,
    ),
  );
}

/**
 * Report the bridge dying as this agent's stop.
 *
 * NanoClaw holds one persistent connection to its application. That connection
 * can fail while the container keeps running, and a container that still
 * reports Running is indistinguishable from a healthy agent to the cluster, so
 * the run would wait on an agent that can no longer be reached. The observer
 * is scope-owned and registered after the session, so releasing the session at
 * teardown interrupts it first and teardown is never read as a disconnect.
 * @param bridge Agent identity and gateway acquisition for one application.
 * @param session Connected gateway and its autonomous failure observation.
 * @param reportStopped Cluster sink for a stop only this runtime can see.
 * @returns An Effect that completes once the observer is running.
 */
function observeGatewayLoss(
  bridge: NanoClawBridge,
  session: NanoClawGatewaySession,
  reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> {
  return session.failure.pipe(
    Effect.catchAll((cause) =>
      reportStopped(gatewayDisconnected(bridge.agentName, cause)),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  );
}

function gatewayDisconnected(
  agentName: AgentName,
  cause: unknown,
): RuntimeTermination {
  return RuntimeFailed.make({
    detail: `NanoClaw principal gateway for agent "${agentName}" disconnected: ${String(cause)}`,
  });
}
