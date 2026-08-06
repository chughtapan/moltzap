/** @file Container-backed OpenClaw runtime. */

import type { AgentName } from "@moltzap/protocol/identity";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { httpBaseUrl } from "@moltzap/protocol/network";
import {
  acquisitionFailureFor,
  defineContainerRuntime,
  image,
  routableBridgeEndpoint,
  stoppedBeforeAttach,
  type Application,
  type ApplicationEndpoint,
  type ContainerAgentRuntime,
  type ContainerRuntime,
  type File,
} from "../container.js";
import {
  deepFreeze,
  type AgentRuntimeInput,
  type RuntimeAcquisitionError,
  type RuntimeTermination,
} from "../agent.js";
import {
  Duration,
  Effect,
  Inspectable,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import {
  bootstrapFile,
  configurationDigest,
  digestText,
  McpServerConfiguration,
  mcpConfiguration,
  serializeMoltZapProfileConfig,
  snapshotMcpServers,
  snapshotWorkspaceFiles,
  WorkspaceFileConfiguration,
  workspaceConfiguration,
  workspaceFilePath,
  type CheckedWorkspaceFile,
  type McpServer,
  type WorkspaceFile,
} from "../workspace.js";
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
const OPENCLAW_GATEWAY_PORT = 18_789;
const OPENCLAW_BOOTSTRAP_DIR = "/var/run/moltzap/bootstrap";
const APPLICATION_STATE_DIR = `${OPENCLAW_BOOTSTRAP_DIR}/state`;
const APPLICATION_CONFIG_PATH = `${OPENCLAW_BOOTSTRAP_DIR}/openclaw.json`;
const OPENCLAW_PROFILE_HOME = `${OPENCLAW_BOOTSTRAP_DIR}/moltzap`;
const OPENCLAW_PROFILE_PATH = `${OPENCLAW_PROFILE_HOME}/config.json`;
const OPENCLAW_WORKSPACE_DIR = `${OPENCLAW_BOOTSTRAP_DIR}/workspace`;
const OPENCLAW_CHANNEL_PATH = `${OPENCLAW_BOOTSTRAP_DIR}/openclaw-channel`;
const OPENCLAW_GATEWAY_TOKEN_BYTES = 32;
const OPENCLAW_DEVICE_TOKEN_BYTES = 32;
const OPENCLAW_ED25519_PUBLIC_KEY_BYTES = 32;
const STOCK_OPENCLAW_IMAGE = image.make(
  "ghcr.io/openclaw/openclaw@sha256:27612bb8e5a766ace76fbc2c19276cc9e321f66ad065292eae197f0f5624d371",
);
const APPLICATION_RESOURCES = Object.freeze({
  cpuMillis: 1_000,
  memoryBytes: 1_024 * 1_024 * 1_024,
  ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
});

const acquisitionFailure = acquisitionFailureFor(OPENCLAW_RUNTIME_NAME);

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
  workspaceFiles: Schema.Array(WorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  mcpServers: Schema.Array(McpServerConfiguration),
  tools: Schema.optional(OpenClawNativePolicyConfiguration),
  sandbox: Schema.optional(OpenClawNativePolicyConfiguration),
}) {}

/** Configuration captured by one reusable OpenClaw runtime value. */
export interface OpenClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly WorkspaceFile[];
  readonly modelId?: string;
  readonly mcpServers?: readonly McpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

interface OpenClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly CheckedWorkspaceFile[];
  readonly modelId?: string;
  readonly mcpServers?: readonly McpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

function snapshotNativeConfiguration<Value extends object>(
  value?: Value,
): Value | undefined {
  if (value === undefined) {
    return undefined;
  }
  return deepFreeze(structuredClone(value));
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

type OpenClawGatewayAcquirer = (
  session: OpenClawGatewaySession,
  within: Duration.Duration,
) => Effect.Effect<OpenClawGateway, unknown, Scope.Scope>;

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

function bootstrapFiles<Name extends string>(
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
      channelPath: OPENCLAW_CHANNEL_PATH,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      ...(settings.mcpServers === undefined
        ? {}
        : { mcpServers: settings.mcpServers }),
      ...(settings.tools === undefined ? {} : { tools: settings.tools }),
      ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    },
    OPENCLAW_WORKSPACE_DIR,
  );
  const profile = serializeMoltZapProfileConfig({
    agentName: input.agentName,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
  });
  return Object.freeze([
    bootstrapFile(
      APPLICATION_CONFIG_PATH,
      JSON.stringify(nativeConfig, null, 2),
    ),
    bootstrapFile(OPENCLAW_PROFILE_PATH, profile),
    bootstrapFile(
      `${APPLICATION_STATE_DIR}/devices/paired.json`,
      pairing.pairedDevices,
    ),
    ...settings.workspaceFiles.map((file) =>
      bootstrapFile(
        workspaceFilePath(OPENCLAW_WORKSPACE_DIR, file.relativePath),
        file.content,
      ),
    ),
  ]);
}

function bridgeUrl(
  endpoint: ApplicationEndpoint,
): OpenClawGatewaySession["gatewayUrl"] {
  return `ws://${endpoint.host}:${String(endpoint.port)}/`;
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

interface OpenClawBridge {
  readonly startupTimeout: Duration.Duration;
  readonly agentName: AgentName;
  readonly gatewayToken: Redacted.Redacted;
  readonly deviceIdentity: OpenClawGatewayDeviceIdentity;
  readonly acquireGateway: OpenClawGatewayAcquirer;
}

function attachOpenClaw(
  bridge: OpenClawBridge,
  endpoint: ApplicationEndpoint,
  stopped: Effect.Effect<RuntimeTermination>,
): Effect.Effect<OpenClawGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.gen(function* () {
    const gatewayUrl = yield* Effect.try({
      try: () => bridgeUrl(routableBridgeEndpoint(endpoint)),
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

function makeOpenClawApplication<Name extends string>(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawGatewayAcquirer,
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
      String(OPENCLAW_GATEWAY_PORT),
    ] as const),
    environment: Object.freeze({
      HOME: APPLICATION_STATE_DIR,
      OPENCLAW_STATE_DIR: APPLICATION_STATE_DIR,
      OPENCLAW_CONFIG_PATH: APPLICATION_CONFIG_PATH,
      MOLTZAP_CONFIG_HOME: OPENCLAW_PROFILE_HOME,
      MOLTZAP_SERVER_URL: httpBaseUrl(input.connection.routerUrl),
      OPENCLAW_DISABLE_BONJOUR: "1",
    }),
    ...(settings.modelId === undefined
      ? {}
      : { credentials: Object.freeze(["OPENAI_API_KEY"] as const) }),
    port: OPENCLAW_GATEWAY_PORT,
    files: bootstrapFiles(settings, input, gatewayToken, pairing),
    attach: (
      endpoint: ApplicationEndpoint,
      stopped: Effect.Effect<RuntimeTermination>,
    ) => attachOpenClaw(bridge, endpoint, stopped),
  });
}

function renderOpenClaw<Name extends string>(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawGatewayAcquirer,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  Application<OpenClawGateway, RuntimeAcquisitionError>,
  RuntimeAcquisitionError
> {
  return Effect.try({
    try: () => makeOpenClawApplication(settings, acquireGateway, input),
    catch: (cause) =>
      acquisitionFailure(
        input.agentName,
        "render distributed application",
        cause,
      ),
  });
}

function openClawCapability(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawGatewayAcquirer,
): ContainerRuntime<OpenClawGateway, RuntimeAcquisitionError> {
  return Object.freeze({
    image: STOCK_OPENCLAW_IMAGE,
    resources: APPLICATION_RESOURCES,
    render: <Name extends string>(input: AgentRuntimeInput<Name>) =>
      renderOpenClaw(settings, acquireGateway, input),
  });
}

/**
 * Construct an OpenClaw application container with its native gateway bridge.
 * @param options Options that control the operation.
 * @returns The open claw runtime result.
 */
export function openClawRuntime(
  options: OpenClawRuntimeOptions = {},
): ContainerAgentRuntime<
  OpenClawGateway,
  RuntimeAcquisitionError,
  typeof OpenClawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  const capability = openClawCapability(settings, acquireOpenClawGateway);
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
