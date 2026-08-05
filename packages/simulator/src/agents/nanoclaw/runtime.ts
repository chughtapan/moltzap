/** @file Container-native NanoClaw runtime descriptor. */

import { createHash } from "node:crypto";
import type { AgentName } from "@moltzap/protocol/identity";
import { httpBaseUrl } from "@moltzap/protocol/network";
import { posix } from "node:path";
import {
  defineContainerRuntime,
  stoppedBeforeAttach,
  type Application,
  type ContainerRuntime,
  type File,
  type Image,
} from "../container.js";
import {
  type AgentRuntime,
  type AgentRuntimeInput,
  type RuntimeTermination,
  RuntimeAcquisitionError,
  RuntimeFailed,
} from "../agent.js";
import { Duration, Effect, Schema, type Scope } from "effect";
import { serializeMoltZapProfileConfig } from "../workspace.js";
import {
  acquireDistributedNanoClawGateway,
  type NanoClawGateway,
  type NanoClawGatewaySession,
} from "./gateway.js";

const NANOCLAW_RUNTIME_NAME = "nanoclaw";
const DEFAULT_NANOCLAW_STARTUP_TIMEOUT = Duration.minutes(2);
const NANOCLAW_DISTRIBUTED_GATEWAY_PORT = 18_790;
const NANOCLAW_DISTRIBUTED_BOOTSTRAP_DIR = "/var/run/moltzap/bootstrap";
const NANOCLAW_DISTRIBUTED_CONFIG_PATH = `${NANOCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/nanoclaw/runtime.json`;
const NANOCLAW_DISTRIBUTED_PROFILE_HOME = `${NANOCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/moltzap`;
const NANOCLAW_DISTRIBUTED_PROFILE_PATH = `${NANOCLAW_DISTRIBUTED_PROFILE_HOME}/config.json`;
const NANOCLAW_DISTRIBUTED_WORKSPACE_DIR = `${NANOCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/workspace`;
const NANOCLAW_DISTRIBUTED_STATE_DIR = "/var/lib/moltzap/nanoclaw";
const NANOCLAW_DISTRIBUTED_ENTRYPOINT = "/opt/moltzap/nanoclaw/entrypoint.mjs";
const DISTRIBUTED_APPLICATION_RESOURCES = Object.freeze({
  cpuMillis: 1_000,
  memoryBytes: 1_024 * 1_024 * 1_024,
  ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
});

interface NanoClawWorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

interface NanoClawMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const configurationDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("NanoClawConfigurationDigest"),
);

const distributedApplicationImage = Schema.String.pipe(
  Schema.pattern(/^[^@\s]+@sha256:[\da-f]{64}$/u),
);

class NanoClawWorkspaceFileConfiguration extends Schema.Class<NanoClawWorkspaceFileConfiguration>(
  "NanoClawWorkspaceFileConfiguration",
)({
  relativePath: Schema.String,
  contentDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("content")),
}) {}

class NanoClawMcpServerConfiguration extends Schema.Class<NanoClawMcpServerConfiguration>(
  "NanoClawMcpServerConfiguration",
)({
  name: Schema.String,
  definitionDigest: configurationDigest,
  redacted: Schema.Tuple(
    Schema.Literal("command"),
    Schema.Literal("args"),
    Schema.Literal("environmentValues"),
  ),
}) {}

/**
 * Sanitized definition-time policy for a NanoClaw application container.
 */
export class NanoClawRuntimeConfiguration extends Schema.Class<NanoClawRuntimeConfiguration>(
  "NanoClawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(NanoClawWorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  autoRegisterConversations: Schema.Boolean,
  mcpServers: Schema.Array(NanoClawMcpServerConfiguration),
  applicationImage: distributedApplicationImage,
}) {}

/** Configuration captured by one reusable NanoClaw runtime value. */
export interface NanoClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly NanoClawWorkspaceFile[];
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

  /** Stdio MCP servers mounted into the NanoClaw container workspace. */
  readonly mcpServers?: readonly NanoClawMcpServer[];
}

interface NanoClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly NanoClawWorkspaceFile[];
  readonly modelId?: string;
  readonly applicationImage: Image;
  readonly autoRegisterConversations: boolean;
  readonly mcpServers?: readonly NanoClawMcpServer[];
}

/** Failure returned when NanoClaw cannot become router-visible. */
export type NanoClawRuntimeAcquisitionError = RuntimeAcquisitionError;

function snapshotWorkspaceFiles(
  files?: readonly NanoClawWorkspaceFile[],
): readonly NanoClawWorkspaceFile[] {
  return Object.freeze((files ?? []).map((file) => Object.freeze({ ...file })));
}

function snapshotMcpServers(
  servers?: readonly NanoClawMcpServer[],
): readonly NanoClawMcpServer[] | undefined {
  return servers === undefined
    ? undefined
    : Object.freeze(
        servers.map((server) =>
          Object.freeze({
            name: server.name,
            command: server.command,
            args: Object.freeze([...server.args]),
            env: Object.freeze({ ...server.env }),
          }),
        ),
      );
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

function digestText(value: string): typeof configurationDigest.Type {
  return Schema.decodeUnknownSync(configurationDigest)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );
}

function workspaceConfiguration(
  files: readonly NanoClawWorkspaceFile[],
): readonly NanoClawWorkspaceFileConfiguration[] {
  return files.map((file) =>
    NanoClawWorkspaceFileConfiguration.make({
      relativePath: file.relativePath,
      contentDigest: digestText(file.content),
      redacted: ["content"],
    }),
  );
}

function mcpServerDefinition(server: NanoClawMcpServer): string {
  return JSON.stringify({
    name: server.name,
    command: server.command,
    args: server.args,
    environmentKeys: Object.keys(server.env).sort((left, right) =>
      left.localeCompare(right),
    ),
  });
}

function mcpConfiguration(
  servers?: readonly NanoClawMcpServer[],
): readonly NanoClawMcpServerConfiguration[] {
  return (servers ?? []).map((server) =>
    NanoClawMcpServerConfiguration.make({
      name: server.name,
      definitionDigest: digestText(mcpServerDefinition(server)),
      redacted: ["command", "args", "environmentValues"],
    }),
  );
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

function acquisitionFailure(
  agentName: string,
  operation: string,
  cause: unknown,
): RuntimeAcquisitionError {
  return RuntimeAcquisitionError.make({
    runtime: NANOCLAW_RUNTIME_NAME,
    agent: agentName,
    detail: `${operation}: ${String(cause)}`,
  });
}

interface NanoClawDistributedEndpoint {
  readonly host: string;
  readonly port: number;
}

type NanoClawDistributedGatewayAcquirer = (
  endpoint: NanoClawDistributedEndpoint,
  within: Duration.Duration,
) => Effect.Effect<NanoClawGatewaySession, unknown, Scope.Scope>;

class DistributedNanoClawConfigurationError extends Schema.TaggedError<DistributedNanoClawConfigurationError>()(
  "DistributedNanoClawConfigurationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function distributedConfigurationError(
  detail: string,
): DistributedNanoClawConfigurationError {
  return DistributedNanoClawConfigurationError.make({ detail });
}

function validateDistributedImage(image: Image): void {
  if (!/^[^@\s]+@sha256:[\da-f]{64}$/u.test(image)) {
    throw distributedConfigurationError(
      "the NanoClaw application image must be pinned by a SHA-256 digest",
    );
  }
}

function distributedWorkspacePath(relativePath: string): `/${string}` {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    posix.isAbsolute(relativePath)
  ) {
    throw distributedConfigurationError(
      `invalid NanoClaw workspace path: ${relativePath}`,
    );
  }
  const normalized = posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw distributedConfigurationError(
      `NanoClaw workspace path must stay below its root: ${relativePath}`,
    );
  }
  return `${NANOCLAW_DISTRIBUTED_WORKSPACE_DIR}/${normalized}`;
}

function bootstrapFile(path: `/${string}`, content: string): File {
  return Object.freeze({ path, content, mode: 0o600 });
}

function distributedRuntimeConfig(
  settings: NanoClawRuntimeSettings,
  agentName: AgentName,
): string {
  return JSON.stringify(
    {
      apiVersion: "moltzap.nanoclaw-application/v1",
      agentName,
      gateway: {
        host: "0.0.0.0",
        port: NANOCLAW_DISTRIBUTED_GATEWAY_PORT,
      },
      stateDirectory: NANOCLAW_DISTRIBUTED_STATE_DIR,
      workspaceDirectory: NANOCLAW_DISTRIBUTED_WORKSPACE_DIR,
      autoRegisterConversations: settings.autoRegisterConversations,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      mcpServers: (settings.mcpServers ?? []).map((server) => ({
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
      })),
    },
    null,
    2,
  );
}

function distributedBootstrapFiles<Name extends string>(
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
      NANOCLAW_DISTRIBUTED_CONFIG_PATH,
      distributedRuntimeConfig(settings, input.agentName),
    ),
    bootstrapFile(NANOCLAW_DISTRIBUTED_PROFILE_PATH, profile),
    ...settings.workspaceFiles.map((file) =>
      bootstrapFile(distributedWorkspacePath(file.relativePath), file.content),
    ),
  ]);
}

function distributedEndpoint(parsed: URL): NanoClawDistributedEndpoint {
  const forbiddenHosts = new Set([
    "0.0.0.0",
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ]);
  const invalid = [
    parsed.protocol !== "ws:",
    forbiddenHosts.has(parsed.hostname),
    parsed.port !== String(NANOCLAW_DISTRIBUTED_GATEWAY_PORT),
    parsed.username.length > 0,
    parsed.password.length > 0,
    parsed.pathname !== "/",
    parsed.search.length > 0,
    parsed.hash.length > 0,
  ].includes(true);
  if (invalid) {
    throw distributedConfigurationError(
      `NanoClaw distributed gateway must be a credential-free, non-loopback endpoint on port ${String(NANOCLAW_DISTRIBUTED_GATEWAY_PORT)}`,
    );
  }
  return Object.freeze({
    host: parsed.hostname,
    port: NANOCLAW_DISTRIBUTED_GATEWAY_PORT,
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

interface DistributedNanoClawBridge {
  readonly startupTimeout: Duration.Duration;
  readonly agentName: AgentName;
  readonly acquireGateway: NanoClawDistributedGatewayAcquirer;
}

function gatewayDisconnected(
  agentName: AgentName,
  cause: unknown,
): RuntimeTermination {
  return RuntimeFailed.make({
    detail: `NanoClaw principal gateway for agent "${agentName}" disconnected: ${String(cause)}`,
  });
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
  bridge: DistributedNanoClawBridge,
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

function attachDistributedNanoClaw(
  bridge: DistributedNanoClawBridge,
  endpoint: URL,
  stopped: Effect.Effect<RuntimeTermination>,
  reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
): Effect.Effect<NanoClawGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => distributedEndpoint(endpoint),
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

interface NanoClawDistributedRenderer {
  readonly settings: NanoClawRuntimeSettings;
  readonly acquireGateway: NanoClawDistributedGatewayAcquirer;
}

function makeDistributedNanoClawApplication<Name extends string>(
  renderer: NanoClawDistributedRenderer,
  input: AgentRuntimeInput<Name>,
): Application<NanoClawGateway, RuntimeAcquisitionError> {
  const { settings } = renderer;
  const bridge = {
    startupTimeout: settings.startupTimeout,
    agentName: input.agentName,
    acquireGateway: renderer.acquireGateway,
  };
  return Object.freeze({
    entrypoint: Object.freeze([
      "node",
      NANOCLAW_DISTRIBUTED_ENTRYPOINT,
    ] as const),
    environment: Object.freeze({
      MOLTZAP_PROFILE: "simulator-agent",
      MOLTZAP_CONFIG_HOME: NANOCLAW_DISTRIBUTED_PROFILE_HOME,
      MOLTZAP_SERVER_URL: httpBaseUrl(input.connection.routerUrl),
      MOLTZAP_NANOCLAW_CONFIG: NANOCLAW_DISTRIBUTED_CONFIG_PATH,
      MOLTZAP_NANOCLAW_STATE: NANOCLAW_DISTRIBUTED_STATE_DIR,
    }),
    ...(settings.modelId === undefined
      ? {}
      : { credentials: Object.freeze(["ANTHROPIC_API_KEY"] as const) }),
    port: NANOCLAW_DISTRIBUTED_GATEWAY_PORT,
    files: distributedBootstrapFiles(settings, input),
    attach: (
      endpoint: URL,
      stopped: Effect.Effect<RuntimeTermination>,
      reportStopped: (termination: RuntimeTermination) => Effect.Effect<void>,
    ) => attachDistributedNanoClaw(bridge, endpoint, stopped, reportStopped),
  });
}

function renderDistributedNanoClaw<Name extends string>(
  renderer: NanoClawDistributedRenderer,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  Application<NanoClawGateway, RuntimeAcquisitionError>,
  RuntimeAcquisitionError
> {
  return Effect.try({
    try: () => makeDistributedNanoClawApplication(renderer, input),
    catch: (cause) =>
      acquisitionFailure(
        input.agentName,
        "render distributed application",
        cause,
      ),
  });
}

function nanoclawDistributedCapability(
  settings: NanoClawRuntimeSettings,
  image: Image,
  acquireGateway: NanoClawDistributedGatewayAcquirer,
): ContainerRuntime<NanoClawGateway, RuntimeAcquisitionError> {
  validateDistributedImage(image);
  const renderer: NanoClawDistributedRenderer = { settings, acquireGateway };
  return Object.freeze({
    image,
    resources: DISTRIBUTED_APPLICATION_RESOURCES,
    render: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      renderDistributedNanoClaw(renderer, input),
  });
}

/**
 * Construct a NanoClaw descriptor backed by one application container per
 * roster identity and its runtime-owned native gateway bridge.
 * @param options Options that control the operation.
 * @returns The nanoclaw runtime result.
 */
export function nanoclawRuntime(
  options: NanoClawRuntimeOptions,
): AgentRuntime<
  NanoClawGateway,
  NanoClawRuntimeAcquisitionError,
  typeof NanoClawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  const capability = nanoclawDistributedCapability(
    settings,
    settings.applicationImage,
    (endpoint, within) =>
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
