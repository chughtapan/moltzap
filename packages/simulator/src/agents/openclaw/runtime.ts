/** @file Container-backed OpenClaw runtime. */

import type { AgentName } from "@moltzap/protocol/identity";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { httpBaseUrl } from "@moltzap/protocol/network";
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
} from "../agent.js";
import {
  Duration,
  Effect,
  Inspectable,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { serializeMoltZapProfileConfig } from "../workspace.js";
import {
  buildOpenClawConfig,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./configuration.js";
import {
  acquireOpenClawGateway,
  type OpenClawGateway,
  type OpenClawGatewayDeviceIdentity,
  type OpenClawGatewaySession,
  OpenClawGatewayStoppedBeforeHello,
} from "./gateway.js";

/** Native OpenClaw policy types accepted by the shipped runtime. */
export type {
  OpenClawSandboxConfig,
  OpenClawToolsConfig,
} from "./configuration.js";

const OPENCLAW_RUNTIME_NAME = "openclaw";
const DEFAULT_OPENCLAW_STARTUP_TIMEOUT = Duration.minutes(2);
const OPENCLAW_DISTRIBUTED_GATEWAY_PORT = 18_789;
const OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR = "/var/run/moltzap/bootstrap";
const OPENCLAW_DISTRIBUTED_STATE_DIR = `${OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/state`;
const OPENCLAW_DISTRIBUTED_CONFIG_PATH = `${OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/openclaw.json`;
const OPENCLAW_DISTRIBUTED_PROFILE_HOME = `${OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/moltzap`;
const OPENCLAW_DISTRIBUTED_PROFILE_PATH = `${OPENCLAW_DISTRIBUTED_PROFILE_HOME}/config.json`;
const OPENCLAW_DISTRIBUTED_WORKSPACE_DIR = `${OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/workspace`;
const OPENCLAW_DISTRIBUTED_CHANNEL_PATH = `${OPENCLAW_DISTRIBUTED_BOOTSTRAP_DIR}/openclaw-channel`;
const OPENCLAW_GATEWAY_TOKEN_BYTES = 32;
const OPENCLAW_DEVICE_TOKEN_BYTES = 32;
const OPENCLAW_ED25519_PUBLIC_KEY_BYTES = 32;
const STOCK_OPENCLAW_IMAGE =
  "ghcr.io/openclaw/openclaw@sha256:27612bb8e5a766ace76fbc2c19276cc9e321f66ad065292eae197f0f5624d371" satisfies Image;
const DISTRIBUTED_APPLICATION_RESOURCES = Object.freeze({
  cpuMillis: 1_000,
  memoryBytes: 1_024 * 1_024 * 1_024,
  ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
});

interface OpenClawWorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}

interface OpenClawMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const configurationDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("OpenClawConfigurationDigest"),
);

class OpenClawWorkspaceFileConfiguration extends Schema.Class<OpenClawWorkspaceFileConfiguration>(
  "OpenClawWorkspaceFileConfiguration",
)({
  relativePath: Schema.String,
  contentDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("content")),
}) {}

class OpenClawMcpServerConfiguration extends Schema.Class<OpenClawMcpServerConfiguration>(
  "OpenClawMcpServerConfiguration",
)({
  name: Schema.String,
  definitionDigest: configurationDigest,
  redacted: Schema.Tuple(
    Schema.Literal("command"),
    Schema.Literal("args"),
    Schema.Literal("environmentValues"),
  ),
}) {}

class OpenClawNativePolicyConfiguration extends Schema.Class<OpenClawNativePolicyConfiguration>(
  "OpenClawNativePolicyConfiguration",
)({
  definitionDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("configuration")),
}) {}

/**
 * Sanitized definition-time policy for an OpenClaw application container.
 */
export class OpenClawRuntimeConfiguration extends Schema.Class<OpenClawRuntimeConfiguration>(
  "OpenClawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(OpenClawWorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  mcpServers: Schema.Array(OpenClawMcpServerConfiguration),
  tools: Schema.optional(OpenClawNativePolicyConfiguration),
  sandbox: Schema.optional(OpenClawNativePolicyConfiguration),
}) {}

/** Configuration captured by one reusable OpenClaw runtime value. */
export interface OpenClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

interface OpenClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

/** Failure returned when OpenClaw cannot become router-visible. */
export type OpenClawRuntimeAcquisitionError = RuntimeAcquisitionError;

function snapshotWorkspaceFiles(
  files?: readonly OpenClawWorkspaceFile[],
): readonly OpenClawWorkspaceFile[] {
  return Object.freeze((files ?? []).map((file) => Object.freeze({ ...file })));
}

function snapshotMcpServers(
  servers?: readonly OpenClawMcpServer[],
): readonly OpenClawMcpServer[] | undefined {
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

function freezeNativeConfiguration(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    freezeNativeConfiguration(nested);
  }
  Object.freeze(value);
}

function snapshotNativeConfiguration<Value extends object>(
  value?: Value,
): Value | undefined {
  if (value === undefined) {
    return undefined;
  }
  const snapshot = structuredClone(value);
  freezeNativeConfiguration(snapshot);
  return snapshot;
}

function snapshotOptions(
  options: OpenClawRuntimeOptions,
): OpenClawRuntimeSettings {
  return Object.freeze({
    startupTimeout: options.startupTimeout ?? DEFAULT_OPENCLAW_STARTUP_TIMEOUT,
    workspaceFiles: snapshotWorkspaceFiles(options.workspaceFiles),
    modelId: options.modelId,
    mcpServers: snapshotMcpServers(options.mcpServers),
    tools: snapshotNativeConfiguration(options.tools),
    sandbox: snapshotNativeConfiguration(options.sandbox),
  });
}

function digestText(value: string): typeof configurationDigest.Type {
  return Schema.decodeUnknownSync(configurationDigest)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );
}

function workspaceConfiguration(
  files: readonly OpenClawWorkspaceFile[],
): readonly OpenClawWorkspaceFileConfiguration[] {
  return files.map((file) =>
    OpenClawWorkspaceFileConfiguration.make({
      relativePath: file.relativePath,
      contentDigest: digestText(file.content),
      redacted: ["content"],
    }),
  );
}

function mcpServerDefinition(server: OpenClawMcpServer): string {
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
  servers?: readonly OpenClawMcpServer[],
): readonly OpenClawMcpServerConfiguration[] {
  return (servers ?? []).map((server) =>
    OpenClawMcpServerConfiguration.make({
      name: server.name,
      definitionDigest: digestText(mcpServerDefinition(server)),
      redacted: ["command", "args", "environmentValues"],
    }),
  );
}

function nativePolicyConfiguration(
  policy?: object,
): OpenClawNativePolicyConfiguration | undefined {
  if (policy === undefined) {
    return undefined;
  }
  return OpenClawNativePolicyConfiguration.make({
    definitionDigest: digestText(Inspectable.stringifyCircular(policy)),
    redacted: ["configuration"],
  });
}

function runtimeConfiguration(
  settings: OpenClawRuntimeSettings,
): OpenClawRuntimeConfiguration {
  const tools = nativePolicyConfiguration(settings.tools);
  const sandbox = nativePolicyConfiguration(settings.sandbox);
  return OpenClawRuntimeConfiguration.make({
    startupTimeout: settings.startupTimeout,
    workspaceFiles: workspaceConfiguration(settings.workspaceFiles),
    mcpServers: mcpConfiguration(settings.mcpServers),
    ...(tools === undefined ? {} : { tools }),
    ...(sandbox === undefined ? {} : { sandbox }),
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
    runtime: OPENCLAW_RUNTIME_NAME,
    agent: agentName,
    detail: `${operation}: ${String(cause)}`,
  });
}

type OpenClawDistributedGatewayAcquirer = (
  session: OpenClawGatewaySession,
  within: Duration.Duration,
) => Effect.Effect<OpenClawGateway, unknown, Scope.Scope>;

class DistributedOpenClawConfigurationError extends Schema.TaggedError<DistributedOpenClawConfigurationError>()(
  "DistributedOpenClawConfigurationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

function distributedConfigurationError(
  detail: string,
): DistributedOpenClawConfigurationError {
  return DistributedOpenClawConfigurationError.make({ detail });
}

function distributedWorkspacePath(relativePath: string): `/${string}` {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    posix.isAbsolute(relativePath)
  ) {
    throw distributedConfigurationError(
      `invalid OpenClaw workspace path: ${relativePath}`,
    );
  }
  const normalized = posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw distributedConfigurationError(
      `OpenClaw workspace path must stay below its root: ${relativePath}`,
    );
  }
  return `${OPENCLAW_DISTRIBUTED_WORKSPACE_DIR}/${normalized}`;
}

function bootstrapFile(path: `/${string}`, content: string): File {
  return Object.freeze({ path, content, mode: 0o600 });
}

interface OpenClawGatewayPairing {
  readonly deviceIdentity: OpenClawGatewayDeviceIdentity;
  readonly pairedDevices: string;
}

function createOpenClawGatewayPairing(): OpenClawGatewayPairing {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyRaw = publicKeyDer.subarray(
    -OPENCLAW_ED25519_PUBLIC_KEY_BYTES,
  );
  const deviceIdentity = Object.freeze({
    deviceId: createHash("sha256").update(publicKeyRaw).digest("hex"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  const now = Date.now();
  const operatorWrite = "operator.write";
  return Object.freeze({
    deviceIdentity,
    pairedDevices: JSON.stringify({
      [deviceIdentity.deviceId]: {
        deviceId: deviceIdentity.deviceId,
        publicKey: publicKeyRaw.toString("base64url"),
        displayName: "MoltZap simulator",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        roles: ["operator"],
        scopes: [operatorWrite],
        approvedScopes: [operatorWrite],
        tokens: {
          operator: {
            token: randomBytes(OPENCLAW_DEVICE_TOKEN_BYTES).toString(
              "base64url",
            ),
            role: "operator",
            scopes: [operatorWrite],
            createdAtMs: now,
          },
        },
        createdAtMs: now,
        approvedAtMs: now,
      },
    }),
  });
}

function distributedBootstrapFiles<Name extends string>(
  settings: OpenClawRuntimeSettings,
  input: AgentRuntimeInput<Name>,
  gatewayToken: Redacted.Redacted,
  pairing: OpenClawGatewayPairing,
): readonly File[] {
  const nativeConfig = buildOpenClawConfig(
    {
      agentName: input.agentName,
      gatewayToken,
      gatewayBind: "lan",
      channelPath: OPENCLAW_DISTRIBUTED_CHANNEL_PATH,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      ...(settings.mcpServers === undefined
        ? {}
        : { mcpServers: settings.mcpServers }),
      ...(settings.tools === undefined ? {} : { tools: settings.tools }),
      ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    },
    OPENCLAW_DISTRIBUTED_WORKSPACE_DIR,
  );
  const profile = serializeMoltZapProfileConfig({
    agentName: input.agentName,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
  });
  return Object.freeze([
    bootstrapFile(
      OPENCLAW_DISTRIBUTED_CONFIG_PATH,
      JSON.stringify(nativeConfig, null, 2),
    ),
    bootstrapFile(OPENCLAW_DISTRIBUTED_PROFILE_PATH, profile),
    bootstrapFile(
      `${OPENCLAW_DISTRIBUTED_STATE_DIR}/devices/paired.json`,
      pairing.pairedDevices,
    ),
    ...settings.workspaceFiles.map((file) =>
      bootstrapFile(distributedWorkspacePath(file.relativePath), file.content),
    ),
  ]);
}

function distributedGatewayUrl(
  parsed: URL,
): OpenClawGatewaySession["gatewayUrl"] {
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
    parsed.port !== String(OPENCLAW_DISTRIBUTED_GATEWAY_PORT),
    parsed.username.length > 0,
    parsed.password.length > 0,
    parsed.pathname !== "/",
    parsed.search.length > 0,
    parsed.hash.length > 0,
  ].includes(true);
  if (invalid) {
    throw distributedConfigurationError(
      `OpenClaw distributed gateway must be a credential-free, non-loopback ws URL on port ${String(OPENCLAW_DISTRIBUTED_GATEWAY_PORT)}`,
    );
  }
  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The protocol validation above accepts only a ws URL.
  return parsed.href as OpenClawGatewaySession["gatewayUrl"];
}

function stoppedBeforeGatewayHello(
  stopped: Effect.Effect<RuntimeTermination>,
): OpenClawGatewaySession["stopped"] {
  return stoppedBeforeAttach(stopped, (detail) =>
    OpenClawGatewayStoppedBeforeHello.make({
      detail: `OpenClaw application stopped before gateway hello: ${detail}`,
    }),
  );
}

interface DistributedOpenClawBridge {
  readonly startupTimeout: Duration.Duration;
  readonly agentName: AgentName;
  readonly gatewayToken: Redacted.Redacted;
  readonly deviceIdentity: OpenClawGatewayDeviceIdentity;
  readonly acquireGateway: OpenClawDistributedGatewayAcquirer;
}

function attachDistributedOpenClaw(
  bridge: DistributedOpenClawBridge,
  endpoint: URL,
  stopped: Effect.Effect<RuntimeTermination>,
): Effect.Effect<OpenClawGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.gen(function* () {
    const gatewayUrl = yield* Effect.try({
      try: () => distributedGatewayUrl(endpoint),
      catch: (cause) =>
        acquisitionFailure(
          bridge.agentName,
          "resolve distributed gateway",
          cause,
        ),
    });
    return yield* bridge
      .acquireGateway(
        {
          gatewayUrl,
          gatewayToken: bridge.gatewayToken,
          deviceIdentity: bridge.deviceIdentity,
          agentName: bridge.agentName,
          stopped: stoppedBeforeGatewayHello(stopped),
        },
        bridge.startupTimeout,
      )
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(
            bridge.agentName,
            "connect distributed principal gateway",
            cause,
          ),
        ),
      );
  });
}

function makeDistributedOpenClawApplication<Name extends string>(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawDistributedGatewayAcquirer,
  input: AgentRuntimeInput<Name>,
): Application<OpenClawGateway, RuntimeAcquisitionError> {
  const gatewayToken = Redacted.make(
    randomBytes(OPENCLAW_GATEWAY_TOKEN_BYTES).toString("hex"),
  );
  const pairing = createOpenClawGatewayPairing();
  const bridge = {
    startupTimeout: settings.startupTimeout,
    agentName: input.agentName,
    gatewayToken,
    deviceIdentity: pairing.deviceIdentity,
    acquireGateway,
  };
  return Object.freeze({
    entrypoint: Object.freeze([
      "node",
      "/app/openclaw.mjs",
      "gateway",
      "run",
      "--allow-unconfigured",
      "--port",
      String(OPENCLAW_DISTRIBUTED_GATEWAY_PORT),
    ] as const),
    environment: Object.freeze({
      HOME: OPENCLAW_DISTRIBUTED_STATE_DIR,
      OPENCLAW_STATE_DIR: OPENCLAW_DISTRIBUTED_STATE_DIR,
      OPENCLAW_CONFIG_PATH: OPENCLAW_DISTRIBUTED_CONFIG_PATH,
      MOLTZAP_CONFIG_HOME: OPENCLAW_DISTRIBUTED_PROFILE_HOME,
      MOLTZAP_SERVER_URL: httpBaseUrl(input.connection.routerUrl),
      OPENCLAW_DISABLE_BONJOUR: "1",
    }),
    ...(settings.modelId === undefined
      ? {}
      : { credentials: Object.freeze(["OPENAI_API_KEY"] as const) }),
    port: OPENCLAW_DISTRIBUTED_GATEWAY_PORT,
    files: distributedBootstrapFiles(settings, input, gatewayToken, pairing),
    attach: (endpoint: URL, stopped: Effect.Effect<RuntimeTermination>) =>
      attachDistributedOpenClaw(bridge, endpoint, stopped),
  });
}

function renderDistributedOpenClaw<Name extends string>(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawDistributedGatewayAcquirer,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  Application<OpenClawGateway, RuntimeAcquisitionError>,
  RuntimeAcquisitionError
> {
  return Effect.try({
    try: () =>
      makeDistributedOpenClawApplication(settings, acquireGateway, input),
    catch: (cause) =>
      acquisitionFailure(
        input.agentName,
        "render distributed application",
        cause,
      ),
  });
}

function openClawDistributedCapability(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawDistributedGatewayAcquirer,
): ContainerRuntime<OpenClawGateway, RuntimeAcquisitionError> {
  return Object.freeze({
    image: STOCK_OPENCLAW_IMAGE,
    resources: DISTRIBUTED_APPLICATION_RESOURCES,
    render: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      renderDistributedOpenClaw(settings, acquireGateway, input),
  });
}

/**
 * Construct an OpenClaw application container with its native gateway bridge.
 * @param options Options that control the operation.
 * @returns The open claw runtime result.
 */
export function openClawRuntime(
  options: OpenClawRuntimeOptions = {},
): AgentRuntime<
  OpenClawGateway,
  OpenClawRuntimeAcquisitionError,
  typeof OpenClawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  const capability = openClawDistributedCapability(
    settings,
    acquireOpenClawGateway,
  );
  return defineContainerRuntime({
    name: OPENCLAW_RUNTIME_NAME,
    configuration: {
      schema: OpenClawRuntimeConfiguration,
      value: runtimeConfiguration(settings),
    },
    image: capability.image,
    resources: capability.resources,
    render: capability.render,
  });
}
