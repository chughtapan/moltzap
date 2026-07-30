/** @file Scoped OpenClaw runtime. */

import type { FileSystem, Path } from "@effect/platform";
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
import { Duration, Effect, type Scope } from "effect";
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
      catch: (cause) => cause,
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
): AgentRuntime<OpenClawRuntimeAcquisitionError, Requirements> {
  const settings = snapshotOptions(options);
  return defineRuntime<OpenClawRuntimeAcquisitionError, Requirements>({
    name: OPENCLAW_RUNTIME_NAME,
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
): AgentRuntime<OpenClawRuntimeAcquisitionError, OpenClawHostServices> {
  return makeOpenClawRuntimeWith(options, nativeOpenClawDriver);
}
