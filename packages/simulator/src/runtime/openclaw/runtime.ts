/** @file Scoped OpenClaw runtime. */

import type { FileSystem, Path } from "@effect/platform";
import { createHash } from "node:crypto";
import type {
  CommandExecutor,
  ExitCode,
} from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import {
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeInput,
  type RunningAgent,
} from "../runtime.js";
import {
  Cause,
  Duration,
  Effect,
  Inspectable,
  Schema,
  type Scope,
} from "effect";
import { resolveInstallMode, type InstallMode } from "../packages.js";
import {
  acquireOpenClawProcess,
  resolveOpenClawProcessOptions,
  type OpenClawProcessInput,
  type OpenClawProcessOptionOverrides,
  type OpenClawProcessOptions,
  type OpenClawProcessSession,
  type OpenClawSandboxConfig,
  type OpenClawToolsConfig,
} from "./process.js";
import { acquireOpenClawGateway, type OpenClawGateway } from "./gateway.js";
import {
  awaitProcessReady,
  processTermination,
  type ProcessObservation,
  RuntimeAcquisitionFailed,
} from "../process.js";

/** Native OpenClaw policy types accepted by the shipped runtime. */
export type { OpenClawSandboxConfig, OpenClawToolsConfig } from "./process.js";

const OPENCLAW_RUNTIME_NAME = "openclaw";
const DEFAULT_OPENCLAW_STARTUP_TIMEOUT = Duration.minutes(2);

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

class OpenClawHostPathConfiguration extends Schema.Class<OpenClawHostPathConfiguration>(
  "OpenClawHostPathConfiguration",
)({
  digest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("path")),
}) {}

class OpenClawNativePolicyConfiguration extends Schema.Class<OpenClawNativePolicyConfiguration>(
  "OpenClawNativePolicyConfiguration",
)({
  definitionDigest: configurationDigest,
  redacted: Schema.Tuple(Schema.Literal("configuration")),
}) {}

/**
 * Sanitized definition-time policy and overrides for an OpenClaw runtime.
 * Acquisition may resolve different host facts from automatic policy.
 */
export class OpenClawRuntimeConfiguration extends Schema.Class<OpenClawRuntimeConfiguration>(
  "OpenClawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(OpenClawWorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  installPolicy: Schema.Literal("automatic", "published", "workspace"),
  openclawBinOverride: Schema.optional(OpenClawHostPathConfiguration),
  channelDistDirOverride: Schema.optional(OpenClawHostPathConfiguration),
  mcpServers: Schema.Array(OpenClawMcpServerConfiguration),
  tools: Schema.optional(OpenClawNativePolicyConfiguration),
  sandbox: Schema.optional(OpenClawNativePolicyConfiguration),
}) {}

/** Configuration captured by one reusable OpenClaw runtime value. */
export interface OpenClawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

interface OpenClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
  readonly tools?: OpenClawToolsConfig;
  readonly sandbox?: OpenClawSandboxConfig;
}

/**
 * OpenClaw-specific host seam. Production binds it to the scoped process
 * primitive; lifecycle tests bind controlled sessions without launching a
 * gateway.
 * @internal
 */
export interface OpenClawRuntimeDriver<
  Session,
  WaitFailure = unknown,
  Requirements = never,
> {
  readonly resolveInstallMode: (
    requested?: InstallMode,
  ) => Effect.Effect<InstallMode, unknown>;
  readonly resolveProcessOptions: (
    input: OpenClawProcessOptionOverrides,
  ) => Effect.Effect<OpenClawProcessOptions, unknown>;
  readonly acquire: (
    options: OpenClawProcessOptions,
    input: OpenClawProcessInput,
  ) => Effect.Effect<Session, unknown, Scope.Scope | Requirements>;
  readonly acquireGateway: (
    session: Session,
    within: Duration.Duration,
  ) => Effect.Effect<OpenClawGateway, unknown, Scope.Scope | Requirements>;
  readonly exitCode: (session: Session) => Effect.Effect<ExitCode, WaitFailure>;
  readonly output: (session: Session) => string;
}

/** Failure returned when OpenClaw cannot become router-visible. */
export type OpenClawRuntimeAcquisitionError = RuntimeAcquisitionFailed;

type OpenClawHostServices = CommandExecutor | FileSystem.FileSystem | Path.Path;

const nativeOpenClawDriver: OpenClawRuntimeDriver<
  OpenClawProcessSession,
  PlatformError,
  OpenClawHostServices
> = {
  resolveInstallMode,
  resolveProcessOptions: (input) =>
    Effect.try({
      try: () => resolveOpenClawProcessOptions(input),
      catch: (cause) => new Cause.UnknownException(cause),
    }),
  acquire: acquireOpenClawProcess,
  acquireGateway: acquireOpenClawGateway,
  exitCode: (session) => session.exitCode,
  output: (session) => session.output(),
};

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
    installMode: options.installMode,
    openclawBin: options.openclawBin,
    channelDistDir: options.channelDistDir,
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
    installPolicy: settings.installMode ?? "automatic",
    mcpServers: mcpConfiguration(settings.mcpServers),
    ...(tools === undefined ? {} : { tools }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(settings.modelId === undefined
      ? {}
      : { modelOverride: settings.modelId }),
    ...(settings.openclawBin === undefined
      ? {}
      : {
          openclawBinOverride: OpenClawHostPathConfiguration.make({
            digest: digestText(settings.openclawBin),
            redacted: ["path"],
          }),
        }),
    ...(settings.channelDistDir === undefined
      ? {}
      : {
          channelDistDirOverride: OpenClawHostPathConfiguration.make({
            digest: digestText(settings.channelDistDir),
            redacted: ["path"],
          }),
        }),
  });
}

function processOptions(
  settings: OpenClawRuntimeSettings,
  installMode: InstallMode,
): OpenClawProcessOptionOverrides {
  return {
    installMode,
    ...(settings.openclawBin === undefined
      ? {}
      : { openclawBin: settings.openclawBin }),
    ...(settings.channelDistDir === undefined
      ? {}
      : { channelDistDir: settings.channelDistDir }),
    ...(settings.mcpServers === undefined
      ? {}
      : { mcpServers: settings.mcpServers }),
  };
}

function processInput<Name extends string>(
  input: AgentRuntimeInput<Name>,
  settings: OpenClawRuntimeSettings,
): OpenClawProcessInput {
  return {
    agentName: input.agentName,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
    serverUrl: input.connection.routerUrl,
    workspaceFiles: settings.workspaceFiles,
    ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
    ...(settings.tools === undefined ? {} : { tools: settings.tools }),
    ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
  };
}

function acquisitionFailure(
  agentName: string,
  operation: string,
  cause: unknown,
): RuntimeAcquisitionFailed {
  return RuntimeAcquisitionFailed.make({
    runtime: OPENCLAW_RUNTIME_NAME,
    agent: agentName,
    detail: `${operation}: ${String(cause)}`,
  });
}

interface AcquiredOpenClawProcess<Session, WaitFailure> {
  readonly input: OpenClawProcessInput;
  readonly observation: ProcessObservation<WaitFailure>;
  readonly session: Session;
}

function acquireOpenClawSession<
  Name extends string,
  Session,
  WaitFailure,
  Requirements,
>(
  settings: OpenClawRuntimeSettings,
  driver: OpenClawRuntimeDriver<Session, WaitFailure, Requirements>,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  AcquiredOpenClawProcess<Session, WaitFailure>,
  OpenClawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  return Effect.gen(function* () {
    const process = processInput(input, settings);
    const installMode = yield* driver
      .resolveInstallMode(settings.installMode)
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(process.agentName, "select packages", cause),
        ),
      );
    const host = yield* driver
      .resolveProcessOptions(processOptions(settings, installMode))
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(process.agentName, "resolve process", cause),
        ),
      );
    const session = yield* driver
      .acquire(host, process)
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(process.agentName, "acquire process", cause),
        ),
      );
    const observation: ProcessObservation<WaitFailure> = {
      exitCode: driver.exitCode(session),
      output: () => driver.output(session),
    };
    return { input: process, observation, session };
  });
}

function acquireOpenClawRuntime<
  Name extends string,
  Session,
  WaitFailure,
  Requirements,
>(
  settings: OpenClawRuntimeSettings,
  driver: OpenClawRuntimeDriver<Session, WaitFailure, Requirements>,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  RunningAgent<OpenClawGateway>,
  OpenClawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  return Effect.gen(function* () {
    const process = yield* acquireOpenClawSession(settings, driver, input);
    const gateway = yield* awaitOpenClawRuntimeReady(
      settings,
      driver,
      input,
      process,
    );
    return {
      gateway,
      termination: processTermination(
        {
          agentName: process.input.agentName,
          runtimeName: OPENCLAW_RUNTIME_NAME,
        },
        process.observation,
      ),
    };
  }).pipe(
    Effect.withSpan("openClawRuntime.acquire", {
      attributes: {
        "agent.name": input.connection.agent.name,
        "runtime.name": OPENCLAW_RUNTIME_NAME,
      },
    }),
  );
}

function awaitOpenClawRuntimeReady<
  Name extends string,
  Session,
  WaitFailure,
  Requirements,
>(
  settings: OpenClawRuntimeSettings,
  driver: OpenClawRuntimeDriver<Session, WaitFailure, Requirements>,
  input: AgentRuntimeInput<Name>,
  process: AcquiredOpenClawProcess<Session, WaitFailure>,
): Effect.Effect<
  OpenClawGateway,
  OpenClawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  const gateway = driver
    .acquireGateway(process.session, settings.startupTimeout)
    .pipe(
      Effect.mapError((cause) =>
        acquisitionFailure(
          process.input.agentName,
          "connect principal gateway",
          cause,
        ),
      ),
    );
  const router = awaitProcessReady({
    connection: input.connection,
    within: settings.startupTimeout,
    agentName: process.input.agentName,
    agentKey: process.input.apiKey,
    runtimeName: OPENCLAW_RUNTIME_NAME,
    observation: process.observation,
  });
  return Effect.all([gateway, router] as const, {
    concurrency: 2,
  }).pipe(Effect.map(([principalGateway]) => principalGateway));
}

/**
 * Build OpenClaw's process-backed runtime against an explicit low-level driver.
 * Production uses {@link openClawRuntime}; this seam keeps lifecycle tests
 * free of gateway processes.
 * @param options Options that control the operation.
 * @param driver Value supplied to the operation.
 * @internal
 * @returns The created open claw runtime with.
 */
export function makeOpenClawRuntimeWith<
  Session,
  WaitFailure = unknown,
  Requirements = never,
>(
  options: OpenClawRuntimeOptions,
  driver: OpenClawRuntimeDriver<Session, WaitFailure, Requirements>,
): AgentRuntime<
  OpenClawGateway,
  OpenClawRuntimeAcquisitionError,
  Requirements,
  typeof OpenClawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  return defineRuntime({
    name: OPENCLAW_RUNTIME_NAME,
    configuration: {
      schema: OpenClawRuntimeConfiguration,
      value: runtimeConfiguration(settings),
    },
    acquire: (input) => acquireOpenClawRuntime(settings, driver, input),
  });
}

/**
 * Construct an OpenClaw runtime that binds each roster identity to one
 * scoped gateway process and waits for router-visible readiness.
 * @param options Options that control the operation.
 * @returns The open claw runtime result.
 */
export function openClawRuntime(
  options: OpenClawRuntimeOptions = {},
): AgentRuntime<
  OpenClawGateway,
  OpenClawRuntimeAcquisitionError,
  OpenClawHostServices,
  typeof OpenClawRuntimeConfiguration
> {
  return makeOpenClawRuntimeWith(options, nativeOpenClawDriver);
}
