/** @file Container-native NanoClaw runtime descriptor. */

import { createHash } from "node:crypto";
import type { AgentName } from "@moltzap/protocol/identity";
import { httpBaseUrl } from "@moltzap/protocol/network";
import { posix } from "node:path";
import {
  type DistributedApplicationAttachment,
  type DistributedApplicationContainer,
  type DistributedApplicationSupport,
  type DistributedBootstrapFile,
  type DistributedContainerImage,
  type DistributedRuntimeApplication,
  type DistributedRuntimeCapability,
  defineDistributedRuntime,
} from "../distributed.js";
import {
  type AgentRuntime,
  type AgentRuntimeInput,
  type RunningAgent,
  RuntimeFailed,
  type RuntimeTermination,
} from "../runtime.js";
import {
  Cause,
  Duration,
  Effect,
  Inspectable,
  Schema,
  type Scope,
} from "effect";
import { serializeMoltZapProfileConfig } from "../workspace.js";
import { RuntimeAcquisitionFailed } from "../process.js";
import {
  acquireDistributedNanoclawGateway,
  type NanoclawGateway,
  type NanoclawGatewaySession,
} from "./gateway.js";

const NANOCLAW_RUNTIME_NAME = "nanoclaw";
const DEFAULT_NANOCLAW_STARTUP_TIMEOUT = Duration.minutes(2);
const NANOCLAW_DISTRIBUTED_GATEWAY_PORT = 18_790;
const NANOCLAW_DISTRIBUTED_READY_MARKER = "NanoClaw distributed bridge ready";
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

interface NanoclawWorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

interface NanoclawMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const configurationDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("NanoclawConfigurationDigest"),
);

const distributedApplicationImage = Schema.String.pipe(
  Schema.pattern(/^[^@\s]+@sha256:[\da-f]{64}$/u),
);

class NanoclawWorkspaceFileConfiguration extends Schema.Class<NanoclawWorkspaceFileConfiguration>(
  "NanoclawWorkspaceFileConfiguration",
)({
  relativePath: Schema.String,
  contentDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("content")),
}) {}

class NanoclawMcpServerConfiguration extends Schema.Class<NanoclawMcpServerConfiguration>(
  "NanoclawMcpServerConfiguration",
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
export class NanoclawRuntimeConfiguration extends Schema.Class<NanoclawRuntimeConfiguration>(
  "NanoclawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(NanoclawWorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  autoRegisterConversations: Schema.Boolean,
  mcpServers: Schema.Array(NanoclawMcpServerConfiguration),
  applicationImage: distributedApplicationImage,
}) {}

/** Configuration captured by one reusable NanoClaw runtime value. */
export interface NanoclawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly NanoclawWorkspaceFile[];
  readonly modelId?: string;

  /**
   * Digest-pinned one-container NanoClaw artifact for Kubernetes execution.
   */
  readonly applicationImage: DistributedContainerImage;

  /**
   * Register conversations on first delivery in disposable evaluations.
   * Ordinary societies leave registration to their endpoint code.
   */
  readonly autoRegisterConversations?: boolean;

  /** Stdio MCP servers mounted into the NanoClaw container workspace. */
  readonly mcpServers?: readonly NanoclawMcpServer[];
}

interface NanoclawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly NanoclawWorkspaceFile[];
  readonly modelId?: string;
  readonly applicationImage: DistributedContainerImage;
  readonly autoRegisterConversations: boolean;
  readonly mcpServers?: readonly NanoclawMcpServer[];
}

/** Failure returned when NanoClaw cannot become router-visible. */
export type NanoclawRuntimeAcquisitionError = RuntimeAcquisitionFailed;

function snapshotWorkspaceFiles(
  files?: readonly NanoclawWorkspaceFile[],
): readonly NanoclawWorkspaceFile[] {
  return Object.freeze((files ?? []).map((file) => Object.freeze({ ...file })));
}

function snapshotMcpServers(
  servers?: readonly NanoclawMcpServer[],
): readonly NanoclawMcpServer[] | undefined {
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
  options: NanoclawRuntimeOptions,
): NanoclawRuntimeSettings {
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
  files: readonly NanoclawWorkspaceFile[],
): readonly NanoclawWorkspaceFileConfiguration[] {
  return files.map((file) =>
    NanoclawWorkspaceFileConfiguration.make({
      relativePath: file.relativePath,
      contentDigest: digestText(file.content),
      redacted: ["content"],
    }),
  );
}

function mcpServerDefinition(server: NanoclawMcpServer): string {
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
  servers?: readonly NanoclawMcpServer[],
): readonly NanoclawMcpServerConfiguration[] {
  return (servers ?? []).map((server) =>
    NanoclawMcpServerConfiguration.make({
      name: server.name,
      definitionDigest: digestText(mcpServerDefinition(server)),
      redacted: ["command", "args", "environmentValues"],
    }),
  );
}

function runtimeConfiguration(
  settings: NanoclawRuntimeSettings,
): NanoclawRuntimeConfiguration {
  return NanoclawRuntimeConfiguration.make({
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
): RuntimeAcquisitionFailed {
  return RuntimeAcquisitionFailed.make({
    runtime: NANOCLAW_RUNTIME_NAME,
    agent: agentName,
    detail: `${operation}: ${String(cause)}`,
  });
}

interface NanoclawDistributedEndpoint {
  readonly host: string;
  readonly port: number;
}

type NanoclawDistributedGatewayAcquirer = (
  endpoint: NanoclawDistributedEndpoint,
  within: Duration.Duration,
) => Effect.Effect<NanoclawGatewaySession, unknown, Scope.Scope>;

class DistributedNanoclawConfigurationError extends Schema.TaggedError<DistributedNanoclawConfigurationError>()(
  "DistributedNanoclawConfigurationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function distributedConfigurationError(
  detail: string,
): DistributedNanoclawConfigurationError {
  return DistributedNanoclawConfigurationError.make({ detail });
}

function validateDistributedImage(image: DistributedContainerImage): void {
  if (!/^[^@\s]+@sha256:[\da-f]{64}$/u.test(image)) {
    throw distributedConfigurationError(
      "the NanoClaw application image must be pinned by a SHA-256 digest",
    );
  }
}

function validateDistributedSupport(
  support: DistributedApplicationSupport,
): void {
  if (!/^[^@\s]+@sha256:[\da-f]{64}$/u.test(support.supportImage)) {
    throw distributedConfigurationError(
      "the support image must be pinned by a SHA-256 digest",
    );
  }
  if (support.bootstrapSecretIdentity.length === 0) {
    throw distributedConfigurationError(
      "the bootstrap Secret identity must not be empty",
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

function bootstrapFile(
  path: `/${string}`,
  content: string,
): DistributedBootstrapFile {
  return Object.freeze({ path, content, mode: 0o600 });
}

function distributedRuntimeConfig(
  settings: NanoclawRuntimeSettings,
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
  settings: NanoclawRuntimeSettings,
  input: AgentRuntimeInput<Name>,
): readonly DistributedBootstrapFile[] {
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

function distributedEndpoint(endpointUrl: string): NanoclawDistributedEndpoint {
  const parsed = new URL(endpointUrl);
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

function stoppedBeforeDistributedGateway(
  agentName: AgentName,
  stopped: DistributedApplicationAttachment["stopped"],
): Effect.Effect<never, RuntimeAcquisitionFailed> {
  return stopped.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.fail(
          acquisitionFailure(
            agentName,
            "connect distributed principal gateway",
            `NanoClaw application stopped before its bridge was ready: ${Cause.pretty(cause)}`,
          ),
        ),
      onSuccess: (observation) =>
        Effect.fail(
          acquisitionFailure(
            agentName,
            "connect distributed principal gateway",
            `NanoClaw application stopped before its bridge was ready: ${Inspectable.stringifyCircular(observation)}`,
          ),
        ),
    }),
  );
}

function distributedTermination(
  agentName: AgentName,
  gateway: NanoclawGatewaySession,
  applicationTermination: Effect.Effect<RuntimeTermination>,
): Effect.Effect<RuntimeTermination> {
  const gatewayTermination = gateway.failure.pipe(
    Effect.catchAll((cause) =>
      Effect.succeed(
        RuntimeFailed.make({
          detail: `NanoClaw principal gateway for agent "${agentName}" disconnected: ${String(cause)}`,
        }),
      ),
    ),
  );
  return Effect.raceFirst(applicationTermination, gatewayTermination);
}

interface DistributedNanoclawBridge {
  readonly startupTimeout: Duration.Duration;
  readonly agentName: AgentName;
  readonly acquireGateway: NanoclawDistributedGatewayAcquirer;
}

function attachDistributedNanoclaw(
  bridge: DistributedNanoclawBridge,
  attachment: DistributedApplicationAttachment,
): Effect.Effect<
  RunningAgent<NanoclawGateway>,
  RuntimeAcquisitionFailed,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const endpoint = yield* Effect.try({
      try: () => distributedEndpoint(attachment.endpointUrl),
      catch: (cause) =>
        acquisitionFailure(
          bridge.agentName,
          "resolve distributed gateway",
          cause,
        ),
    });
    const acquire = bridge
      .acquireGateway(endpoint, bridge.startupTimeout)
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(
            bridge.agentName,
            "connect distributed principal gateway",
            cause,
          ),
        ),
      );
    const gateway = yield* Effect.raceFirst(
      acquire,
      stoppedBeforeDistributedGateway(bridge.agentName, attachment.stopped),
    );
    return Object.freeze({
      gateway: gateway.gateway,
      termination: distributedTermination(
        bridge.agentName,
        gateway,
        attachment.termination,
      ),
    });
  });
}

function distributedApplicationContainer<Name extends string>(
  settings: NanoclawRuntimeSettings,
  image: DistributedContainerImage,
  input: AgentRuntimeInput<Name>,
): DistributedApplicationContainer {
  return Object.freeze({
    image,
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
      : {
          credentialEnvironment: Object.freeze(["ANTHROPIC_API_KEY"] as const),
        }),
    ports: Object.freeze([NANOCLAW_DISTRIBUTED_GATEWAY_PORT]),
    resources: DISTRIBUTED_APPLICATION_RESOURCES,
  });
}

interface NanoclawDistributedRenderer {
  readonly settings: NanoclawRuntimeSettings;
  readonly image: DistributedContainerImage;
  readonly acquireGateway: NanoclawDistributedGatewayAcquirer;
}

function makeDistributedNanoclawApplication<Name extends string>(
  renderer: NanoclawDistributedRenderer,
  input: AgentRuntimeInput<Name>,
  support: DistributedApplicationSupport,
): DistributedRuntimeApplication<NanoclawGateway, RuntimeAcquisitionFailed> {
  validateDistributedSupport(support);
  return Object.freeze({
    applicationContainer: distributedApplicationContainer(
      renderer.settings,
      renderer.image,
      input,
    ),
    bootstrapSecret: Object.freeze({
      identity: support.bootstrapSecretIdentity,
      supportImage: support.supportImage,
      files: distributedBootstrapFiles(renderer.settings, input),
    }),
    readiness: Object.freeze({
      outputIncludes: NANOCLAW_DISTRIBUTED_READY_MARKER,
    }),
    attach: (attachment: DistributedApplicationAttachment) =>
      attachDistributedNanoclaw(
        {
          startupTimeout: renderer.settings.startupTimeout,
          agentName: input.agentName,
          acquireGateway: renderer.acquireGateway,
        },
        attachment,
      ),
  });
}

function renderDistributedNanoclaw<Name extends string>(
  renderer: NanoclawDistributedRenderer,
  input: AgentRuntimeInput<Name>,
  support: DistributedApplicationSupport,
): Effect.Effect<
  DistributedRuntimeApplication<NanoclawGateway, RuntimeAcquisitionFailed>,
  RuntimeAcquisitionFailed
> {
  return Effect.try({
    try: () => makeDistributedNanoclawApplication(renderer, input, support),
    catch: (cause) =>
      acquisitionFailure(
        input.agentName,
        "render distributed application",
        cause,
      ),
  });
}

function nanoclawDistributedCapability(
  settings: NanoclawRuntimeSettings,
  image: DistributedContainerImage,
  acquireGateway: NanoclawDistributedGatewayAcquirer,
): DistributedRuntimeCapability<NanoclawGateway, RuntimeAcquisitionFailed> {
  validateDistributedImage(image);
  const renderer: NanoclawDistributedRenderer = {
    settings,
    image,
    acquireGateway,
  };
  return Object.freeze({
    reservation: Object.freeze({
      image,
      resources: DISTRIBUTED_APPLICATION_RESOURCES,
    }),
    render: <Name extends string>(
      input: AgentRuntimeInput<Name>,
      support: DistributedApplicationSupport,
    ) => renderDistributedNanoclaw(renderer, input, support),
  });
}

/**
 * Build the private NanoClaw distributed realization against an explicit
 * one-container image and controlled gateway acquirer.
 * @param options Definition-time NanoClaw configuration.
 * @param acquireGateway Runtime-specific controller gateway bridge.
 * @returns The private distributed realization.
 * @internal
 */
export function makeNanoclawDistributedCapabilityWith(
  options: NanoclawRuntimeOptions,
  acquireGateway: NanoclawDistributedGatewayAcquirer,
): DistributedRuntimeCapability<NanoclawGateway, RuntimeAcquisitionFailed> {
  const settings = snapshotOptions(options);
  return nanoclawDistributedCapability(
    settings,
    settings.applicationImage,
    acquireGateway,
  );
}

/**
 * Construct a NanoClaw descriptor backed by one application container per
 * roster identity and its runtime-owned native gateway bridge.
 * @param options Options that control the operation.
 * @returns The nanoclaw runtime result.
 */
export function nanoclawRuntime(
  options: NanoclawRuntimeOptions,
): AgentRuntime<
  NanoclawGateway,
  NanoclawRuntimeAcquisitionError,
  typeof NanoclawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  const capability = nanoclawDistributedCapability(
    settings,
    settings.applicationImage,
    (endpoint, within) =>
      acquireDistributedNanoclawGateway(endpoint.host, endpoint.port, within),
  );
  return defineDistributedRuntime({
    name: NANOCLAW_RUNTIME_NAME,
    configuration: {
      schema: NanoclawRuntimeConfiguration,
      value: runtimeConfiguration(settings),
    },
    reservation: capability.reservation,
    render: capability.render,
  });
}
