/** @file Container-backed OpenClaw runtime. */

import type { AgentName } from "@moltzap/identity";
import {
  Duration,
  Effect,
  Inspectable,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  AgentRuntimeDefinitionError,
  type AgentRuntimeInput,
  deepFreeze,
  type RuntimeAcquisitionError,
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
  providerCredential,
  routableBridgeEndpoint,
  stoppedBeforeAttach,
} from "../container.js";
import {
  bootstrapFile,
  type CheckedWorkspaceFile,
  configurationDigest,
  digestText,
  harvestTargets,
  HISTORY_EXPORT_PATH,
  HISTORY_EXPORT_VARIABLE,
  historyExportTarget,
  mcpConfiguration,
  type McpServer,
  McpServerConfiguration,
  snapshotHarvestPaths,
  snapshotMcpServers,
  snapshotWorkspaceFiles,
  workspaceConfiguration,
  type WorkspaceFile,
  WorkspaceFileConfiguration,
  workspaceFilePath,
  type WorkspaceRelativePath,
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

/** OpenClaw policy types accepted by the shipped runtime. */
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
const OPENCLAW_WORKSPACE_DIR = `${OPENCLAW_BOOTSTRAP_DIR}/workspace`;
const OPENCLAW_GATEWAY_TOKEN_BYTES = 32;
const OPENCLAW_DEVICE_TOKEN_BYTES = 32;
const OPENCLAW_ED25519_PUBLIC_KEY_BYTES = 32;
const messagingMode = Schema.Literal("shared", "private");
const APPLICATION_RESOURCES = Object.freeze({
  cpuMillis: 1_100,
  memoryBytes: 1_280 * 1_024 * 1_024,
  ephemeralStorageBytes: 1_024 * 1_024 * 1_024,
});
const AGENT_IMAGE_ENTRYPOINT = "/opt/moltzap/agent/entrypoint.mjs";

const acquisitionFailure = acquisitionFailureFor(OPENCLAW_RUNTIME_NAME);

class OpenClawPolicySnapshot extends Schema.Class<OpenClawPolicySnapshot>(
  "OpenClawPolicySnapshot",
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
  harvestWorkspaceFiles: Schema.Array(Schema.String),
  historyExport: Schema.Boolean,
  modelOverride: Schema.optional(Schema.String),
  mcpServers: Schema.Array(McpServerConfiguration),
  messagingMode,
  applicationImage: image,
  tools: Schema.optional(OpenClawPolicySnapshot),
  sandbox: Schema.optional(OpenClawPolicySnapshot),
}) {}

/** Configuration captured by one reusable OpenClaw runtime value. */
export interface OpenClawRuntimeOptions {
  /** Digest-pinned complete OpenClaw agent image. */
  readonly applicationImage: Image;
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly WorkspaceFile[];
  /**
   * Workspace-relative files read back from each running agent after the
   * customer program ends and recorded in the ledger, so an experiment can
   * grade what its agents wrote without their exiting.
   */
  readonly harvestWorkspaceFiles?: readonly string[];
  /**
   * Have the agent's `moltzapd` append every delivery and send it completes
   * to a history export, harvested into the ledger as
   * `moltzap-history.ndjson` when the customer program ends.
   */
  readonly historyExport?: boolean;
  readonly modelId?: string;
  readonly mcpServers?: readonly McpServer[];

  /** Selects OpenClaw session isolation for evaluations. Defaults to shared. */
  readonly messagingMode?: "shared" | "private";

  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

/** Workspace filenames OpenClaw injects into the model's context. */
export const OPENCLAW_CONTEXT_FILENAMES: readonly string[] = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
]);

/**
 * Constructs a simulator runtime from a complete, digest-pinned agent image.
 *
 * ```mermaid
 * flowchart LR
 *   Options[Runtime options] --> Definition[OpenClaw runtime definition]
 *   Definition --> Application[Pinned image and generated configuration]
 *   Application --> Channel[MoltZap channel for daemon messages]
 *   Application --> Gateway[OpenClaw agent RPC]
 * ```
 *
 * @param options OpenClaw policy and workspace files for each started agent.
 * @returns A reusable OpenClaw container runtime definition.
 */
export function openClawRuntime(
  options: OpenClawRuntimeOptions,
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

const OPENCLAW_CONTEXT_FILENAME_SET: ReadonlySet<string> = new Set(
  OPENCLAW_CONTEXT_FILENAMES,
);

interface OpenClawRuntimeSettings {
  readonly applicationImage: Image;
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly CheckedWorkspaceFile[];
  readonly invisibleWorkspaceFiles: readonly string[];
  readonly harvestPaths: readonly WorkspaceRelativePath[];
  readonly historyExport: boolean;
  readonly modelId?: string;
  readonly mcpServers?: readonly McpServer[];
  readonly messagingMode: typeof messagingMode.Type;
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

function snapshotOptions(
  options: OpenClawRuntimeOptions,
): OpenClawRuntimeSettings {
  const workspaceFiles = snapshotWorkspaceFiles(options.workspaceFiles);
  const invisibleFiles = invisibleWorkspaceFiles(workspaceFiles);
  const tools = snapshotOpenClawPolicy(options.tools);
  assertWorkspaceFilesReachable(
    invisibleFiles,
    tools?.deny?.includes("*") ?? false,
  );
  return Object.freeze({
    applicationImage: options.applicationImage,
    startupTimeout: options.startupTimeout ?? DEFAULT_OPENCLAW_STARTUP_TIMEOUT,
    workspaceFiles,
    invisibleWorkspaceFiles: invisibleFiles,
    harvestPaths: snapshotHarvestPaths(options.harvestWorkspaceFiles),
    historyExport: options.historyExport ?? false,
    modelId: options.modelId,
    mcpServers: snapshotMcpServers(options.mcpServers),
    messagingMode: options.messagingMode ?? "shared",
    tools,
    sandbox: snapshotOpenClawPolicy(options.sandbox),
  });
}

function assertWorkspaceFilesReachable(
  invisibleFiles: readonly string[],
  denyListContainsWildcard: boolean,
): void {
  if (invisibleFiles.length > 0 && denyListContainsWildcard) {
    throw AgentRuntimeDefinitionError.make({
      detail:
        `workspace files can never reach the model: ${invisibleFiles.join(", ")} ` +
        `are outside OpenClaw's context-injection set (${OPENCLAW_CONTEXT_FILENAMES.join(", ")}) ` +
        "and every tool is denied",
    });
  }
}

function invisibleWorkspaceFiles(
  files: readonly CheckedWorkspaceFile[],
): readonly string[] {
  return Object.freeze(
    files
      .filter((file) => !OPENCLAW_CONTEXT_FILENAME_SET.has(file.relativePath))
      .map((file) => file.relativePath),
  );
}

function snapshotOpenClawPolicy<Value extends object>(
  value?: Value,
): Value | undefined {
  if (value === undefined) {
    return undefined;
  }
  return deepFreeze(structuredClone(value));
}

function runtimeConfiguration(
  settings: OpenClawRuntimeSettings,
): OpenClawRuntimeConfiguration {
  const tools = summarizeOpenClawPolicy(settings.tools);
  const sandbox = summarizeOpenClawPolicy(settings.sandbox);
  return OpenClawRuntimeConfiguration.make({
    applicationImage: settings.applicationImage,
    startupTimeout: settings.startupTimeout,
    workspaceFiles: workspaceConfiguration(settings.workspaceFiles),
    harvestWorkspaceFiles: settings.harvestPaths,
    historyExport: settings.historyExport,
    mcpServers: mcpConfiguration(settings.mcpServers),
    messagingMode: settings.messagingMode,
    ...(tools === undefined ? {} : { tools }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(settings.modelId === undefined
      ? {}
      : { modelOverride: settings.modelId }),
  });
}

function summarizeOpenClawPolicy(
  policy?: object,
): OpenClawPolicySnapshot | undefined {
  if (policy === undefined) {
    return undefined;
  }
  return OpenClawPolicySnapshot.make({
    definitionDigest: digestText(Inspectable.stringifyCircular(policy)),
    redacted: ["configuration"],
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

function makeOpenClawApplication(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawGatewayAcquirer,
  input: AgentRuntimeInput,
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
    invisibleWorkspaceFiles: settings.invisibleWorkspaceFiles,
  };
  const harvest = [
    ...harvestTargets(OPENCLAW_WORKSPACE_DIR, settings.harvestPaths),
    ...(settings.historyExport ? [historyExportTarget()] : []),
  ];
  const credential =
    settings.modelId === undefined
      ? undefined
      : providerCredential(settings.modelId);
  return Object.freeze({
    entrypoint: Object.freeze(["node", AGENT_IMAGE_ENTRYPOINT] as const),
    environment: Object.freeze({
      HOME: APPLICATION_STATE_DIR,
      OPENCLAW_STATE_DIR: APPLICATION_STATE_DIR,
      OPENCLAW_CONFIG_PATH: APPLICATION_CONFIG_PATH,
      OPENCLAW_DISABLE_BONJOUR: "1",
      ...(settings.historyExport
        ? { [HISTORY_EXPORT_VARIABLE]: HISTORY_EXPORT_PATH }
        : {}),
    }),
    ...(credential === undefined
      ? {}
      : { credentials: Object.freeze([credential]) }),
    port: OPENCLAW_GATEWAY_PORT,
    files: bootstrapFiles(settings, input, gatewayToken, pairing),
    ...(harvest.length === 0 ? {} : { harvest }),
    attach: (
      endpoint: ApplicationEndpoint,
      stopped: Effect.Effect<RuntimeTermination>,
    ) => attachOpenClaw(bridge, endpoint, stopped),
  });
}

function createOpenClawGatewayPairing(): OpenClawGatewayPairing {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyRaw = publicKeyDer.subarray(
    -OPENCLAW_ED25519_PUBLIC_KEY_BYTES,
  );
  const deviceIdentity = Object.freeze({
    deviceId: createHash("sha256").update(publicKeyRaw).digest("hex"),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
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

function bootstrapFiles(
  settings: OpenClawRuntimeSettings,
  input: AgentRuntimeInput,
  gatewayToken: Redacted.Redacted,
  pairing: OpenClawGatewayPairing,
): readonly File[] {
  const openClawConfig = buildOpenClawConfig(
    {
      agentName: input.agentName,
      gatewayToken,
      gatewayBind: "lan",
      messagingMode: settings.messagingMode,
      ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
      ...(settings.mcpServers === undefined
        ? {}
        : { mcpServers: settings.mcpServers }),
      ...(settings.tools === undefined ? {} : { tools: settings.tools }),
      ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    },
    OPENCLAW_WORKSPACE_DIR,
  );
  return Object.freeze([
    bootstrapFile(
      APPLICATION_CONFIG_PATH,
      JSON.stringify(openClawConfig, null, 2),
    ),
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
  readonly invisibleWorkspaceFiles: readonly string[];
}

function attachOpenClaw(
  bridge: OpenClawBridge,
  endpoint: ApplicationEndpoint,
  stopped: Effect.Effect<RuntimeTermination>,
): Effect.Effect<OpenClawGateway, RuntimeAcquisitionError, Scope.Scope> {
  return Effect.gen(function* () {
    if (bridge.invisibleWorkspaceFiles.length > 0) {
      yield* Effect.logWarning(
        `workspace files outside OpenClaw's context-injection set are only reachable through tools: ${bridge.invisibleWorkspaceFiles.join(", ")}`,
      );
    }
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

function renderOpenClaw(
  settings: OpenClawRuntimeSettings,
  acquireGateway: OpenClawGatewayAcquirer,
  input: AgentRuntimeInput,
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
    image: settings.applicationImage,
    resources: APPLICATION_RESOURCES,
    render: (input: AgentRuntimeInput) =>
      renderOpenClaw(settings, acquireGateway, input),
  });
}
