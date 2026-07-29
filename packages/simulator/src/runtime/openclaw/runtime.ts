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
import { Cause, Duration, Effect, Schema, type Scope } from "effect";
import { resolveInstallMode, type InstallMode } from "../packages.js";
import {
  acquireOpenClawProcess,
  resolveOpenClawProcessOptions,
  type OpenClawProcessInput,
  type OpenClawProcessOptionOverrides,
  type OpenClawProcessOptions,
  type OpenClawProcessSession,
} from "./process.js";
import {
  awaitProcessReady,
  processTermination,
  type ProcessObservation,
  RuntimeAcquisitionFailed,
} from "../process.js";

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

const ConfigurationDigest = Schema.String.pipe(
  Schema.pattern(/^[\da-f]{64}$/u),
  Schema.brand("OpenClawConfigurationDigest"),
);

class OpenClawWorkspaceFileConfiguration extends Schema.Class<OpenClawWorkspaceFileConfiguration>(
  "OpenClawWorkspaceFileConfiguration",
)({
  relativePath: Schema.String,
  contentDigest: ConfigurationDigest,
  redacted: Schema.Tuple(Schema.Literal("content")),
}) {}

class OpenClawMcpServerConfiguration extends Schema.Class<OpenClawMcpServerConfiguration>(
  "OpenClawMcpServerConfiguration",
)({
  name: Schema.String,
  definitionDigest: ConfigurationDigest,
  redacted: Schema.Tuple(
    Schema.Literal("command"),
    Schema.Literal("args"),
    Schema.Literal("environmentValues"),
  ),
}) {}

class OpenClawHostPathConfiguration extends Schema.Class<OpenClawHostPathConfiguration>(
  "OpenClawHostPathConfiguration",
)({
  digest: ConfigurationDigest,
  redacted: Schema.Tuple(Schema.Literal("path")),
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
}

interface OpenClawRuntimeSettings {
  readonly startupTimeout: Duration.Duration;
  readonly workspaceFiles: readonly OpenClawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly mcpServers?: readonly OpenClawMcpServer[];
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

function snapshotOptions(
  options: OpenClawRuntimeOptions,
): OpenClawRuntimeSettings {
  const modelId = options.modelId;
  const installMode = options.installMode;
  const openclawBin = options.openclawBin;
  const channelDistDir = options.channelDistDir;
  const mcpServers = snapshotMcpServers(options.mcpServers);
  return Object.freeze({
    startupTimeout: options.startupTimeout ?? DEFAULT_OPENCLAW_STARTUP_TIMEOUT,
    workspaceFiles: snapshotWorkspaceFiles(options.workspaceFiles),
    ...(modelId === undefined ? {} : { modelId }),
    ...(installMode === undefined ? {} : { installMode }),
    ...(openclawBin === undefined ? {} : { openclawBin }),
    ...(channelDistDir === undefined ? {} : { channelDistDir }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
}

function digestText(value: string): typeof ConfigurationDigest.Type {
  return Schema.decodeUnknownSync(ConfigurationDigest)(
    createHash("sha256").update(value, "utf8").digest("hex"),
  );
}

function workspaceConfiguration(
  files: ReadonlyArray<OpenClawWorkspaceFile>,
): ReadonlyArray<OpenClawWorkspaceFileConfiguration> {
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
    environmentKeys: Object.keys(server.env).sort(),
  });
}

function mcpConfiguration(
  servers: ReadonlyArray<OpenClawMcpServer> | undefined,
): ReadonlyArray<OpenClawMcpServerConfiguration> {
  return (servers ?? []).map((server) =>
    OpenClawMcpServerConfiguration.make({
      name: server.name,
      definitionDigest: digestText(mcpServerDefinition(server)),
      redacted: ["command", "args", "environmentValues"],
    }),
  );
}

function runtimeConfiguration(
  settings: OpenClawRuntimeSettings,
): OpenClawRuntimeConfiguration {
  return OpenClawRuntimeConfiguration.make({
    startupTimeout: settings.startupTimeout,
    workspaceFiles: workspaceConfiguration(settings.workspaceFiles),
    installPolicy: settings.installMode ?? "automatic",
    mcpServers: mcpConfiguration(settings.mcpServers),
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
    agentName: input.connection.agent.name,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
    serverUrl: input.connection.routerUrl,
    workspaceFiles: settings.workspaceFiles,
    ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
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

interface AcquiredOpenClawProcess<WaitFailure> {
  readonly input: OpenClawProcessInput;
  readonly observation: ProcessObservation<WaitFailure>;
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
  AcquiredOpenClawProcess<WaitFailure>,
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
    return { input: process, observation };
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
  RunningAgent,
  OpenClawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  return Effect.gen(function* () {
    const process = yield* acquireOpenClawSession(settings, driver, input);
    yield* awaitProcessReady({
      connection: input.connection,
      within: settings.startupTimeout,
      agentName: process.input.agentName,
      agentKey: process.input.apiKey,
      runtimeName: OPENCLAW_RUNTIME_NAME,
      observation: process.observation,
    });
    return {
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
  OpenClawRuntimeAcquisitionError,
  OpenClawHostServices,
  typeof OpenClawRuntimeConfiguration
> {
  return makeOpenClawRuntimeWith(options, nativeOpenClawDriver);
}
