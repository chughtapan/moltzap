/** @file Scoped NanoClaw runtime. */

import { Path, type FileSystem, type HttpClient } from "@effect/platform";
import { createHash } from "node:crypto";
import type {
  CommandExecutor,
  ExitCode,
} from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import type { AgentId, AgentKey, AgentName } from "@moltzap/protocol/identity";
import type { ServerBaseUrl } from "@moltzap/protocol/network";
import {
  defineRuntime,
  type AgentRuntime,
  type AgentRuntimeInput,
  type RunningAgent,
  RuntimeFailed,
  type RuntimeTermination,
} from "../runtime.js";
import { Deferred, Duration, Effect, Fiber, Schema, type Scope } from "effect";
import { resolveInstallMode, type InstallMode } from "../packages.js";
import { type AgentConnection, NetworkFailure } from "../../network/router.js";
import {
  ensureNanoclawRuntimeInstalledEffect,
  type NanoclawRuntimeInstall,
} from "./install.js";
import {
  type NanoclawRuntimeHandle,
  startNanoclawRuntimeEffect,
  stopNanoclawRuntimeEffect,
} from "./process.js";
import {
  awaitProcessReady,
  processTermination,
  type ProcessObservation,
  RuntimeAcquisitionFailed,
} from "../process.js";
import {
  acquireNanoclawGateway,
  type NanoclawGateway,
  type NanoclawGatewaySession,
} from "./gateway.js";

const NANOCLAW_RUNTIME_NAME = "nanoclaw";
const DEFAULT_NANOCLAW_STARTUP_TIMEOUT = Duration.minutes(2);

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
 * Sanitized definition-time policy and overrides for a NanoClaw runtime.
 * Acquisition may resolve different host facts from automatic policy.
 */
export class NanoclawRuntimeConfiguration extends Schema.Class<NanoclawRuntimeConfiguration>(
  "NanoclawRuntimeConfiguration",
)({
  startupTimeout: Schema.DurationFromMillis,
  workspaceFiles: Schema.Array(NanoclawWorkspaceFileConfiguration),
  modelOverride: Schema.optional(Schema.String),
  installPolicy: Schema.Literal("automatic", "published", "workspace"),
  autoRegisterConversations: Schema.Boolean,
  mcpServers: Schema.Array(NanoclawMcpServerConfiguration),
}) {}

/** Configuration captured by one reusable NanoClaw runtime value. */
export interface NanoclawRuntimeOptions {
  readonly startupTimeout?: Duration.Duration;
  readonly workspaceFiles?: readonly NanoclawWorkspaceFile[];
  readonly modelId?: string;
  readonly installMode?: InstallMode;

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
  readonly installMode?: InstallMode;
  readonly autoRegisterConversations: boolean;
  readonly mcpServers?: readonly NanoclawMcpServer[];
}

/**
 * Exact low-level process input derived from one router attachment.
 * @internal
 */
export interface NanoclawProcessInput {
  readonly agentName: AgentName;
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
  readonly serverUrl: ServerBaseUrl;
  readonly autoRegisterConversations: boolean;
  readonly workspaceFiles: readonly NanoclawWorkspaceFile[];
  readonly modelId?: string;
  readonly mcpServers?: readonly NanoclawMcpServer[];
}

type NanoclawGatewayAcquirer<Handle, Requirements> = (
  handle: Handle,
  within: Duration.Duration,
) => Effect.Effect<NanoclawGatewaySession, unknown, Scope.Scope | Requirements>;

/**
 * NanoClaw-specific process seam. Production binds this to the immutable
 * install and supervised-process primitives; lifecycle tests bind controlled
 * handles without starting Docker.
 * @internal
 */
export interface NanoclawRuntimeDriver<
  Install,
  Handle,
  WaitFailure = unknown,
  Requirements = never,
> {
  readonly resolveInstallMode: (
    requested?: InstallMode,
  ) => Effect.Effect<InstallMode, unknown>;
  readonly install: (
    mode: InstallMode,
  ) => Effect.Effect<Install, unknown, Requirements>;
  readonly start: (
    input: NanoclawProcessInput,
    install: Install,
  ) => Effect.Effect<Handle, unknown, Requirements>;
  readonly stop: (handle: Handle) => Effect.Effect<void, never, Requirements>;
  readonly gateway: NanoclawGatewayAcquirer<Handle, Requirements>;
  readonly exitCode: (handle: Handle) => Effect.Effect<ExitCode, WaitFailure>;
  readonly output: (handle: Handle) => string;
}

/** Failure returned when NanoClaw cannot become router-visible. */
export type NanoclawRuntimeAcquisitionError = RuntimeAcquisitionFailed;

type NanoclawHostServices =
  | CommandExecutor
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;

const nativeNanoclawDriver: NanoclawRuntimeDriver<
  NanoclawRuntimeInstall,
  NanoclawRuntimeHandle,
  PlatformError,
  NanoclawHostServices
> = {
  resolveInstallMode,
  install: ensureNanoclawRuntimeInstalledEffect,
  start: startNanoclawRuntimeEffect,
  stop: (handle) =>
    stopNanoclawRuntimeEffect(handle).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning("failed to tear down NanoClaw runtime", cause),
      ),
    ),
  gateway: (handle, within) =>
    Path.Path.pipe(
      Effect.flatMap((path) =>
        acquireNanoclawGateway(
          path.join(handle.runtimeDir, "data", "cli.sock"),
          within,
        ),
      ),
    ),
  exitCode: (handle) => Fiber.join(handle.exitFiber),
  output: (handle) => handle.logs.text,
};

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
  const installMode = options.installMode;
  const mcpServers = snapshotMcpServers(options.mcpServers);
  return Object.freeze({
    startupTimeout: options.startupTimeout ?? DEFAULT_NANOCLAW_STARTUP_TIMEOUT,
    workspaceFiles: snapshotWorkspaceFiles(options.workspaceFiles),
    autoRegisterConversations: options.autoRegisterConversations ?? false,
    ...(modelId === undefined ? {} : { modelId }),
    ...(installMode === undefined ? {} : { installMode }),
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
    installPolicy: settings.installMode ?? "automatic",
    autoRegisterConversations: settings.autoRegisterConversations,
    mcpServers: mcpConfiguration(settings.mcpServers),
    ...(settings.modelId === undefined
      ? {}
      : { modelOverride: settings.modelId }),
  });
}

function processInput<Name extends string>(
  input: AgentRuntimeInput<Name>,
  settings: NanoclawRuntimeSettings,
): NanoclawProcessInput {
  return {
    agentName: input.agentName,
    agentId: input.connection.agent.id,
    apiKey: input.connection.key,
    serverUrl: input.connection.routerUrl,
    autoRegisterConversations: settings.autoRegisterConversations,
    workspaceFiles: settings.workspaceFiles,
    ...(settings.modelId === undefined ? {} : { modelId: settings.modelId }),
    ...(settings.mcpServers === undefined
      ? {}
      : { mcpServers: settings.mcpServers }),
  };
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

function startProcessScoped<Install, Handle, WaitFailure, Requirements>(
  process: NanoclawProcessInput,
  install: Install,
  driver: NanoclawRuntimeDriver<Install, Handle, WaitFailure, Requirements>,
): Effect.Effect<Handle, RuntimeAcquisitionFailed, Scope.Scope | Requirements> {
  const start = driver
    .start(process, install)
    .pipe(
      Effect.mapError((cause) =>
        acquisitionFailure(process.agentName, "start process", cause),
      ),
    );
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const handle = yield* restore(start);
      yield* Effect.addFinalizer(() => driver.stop(handle));
      return handle;
    }),
  );
}

interface AcquiredNanoclawProcess<Handle, WaitFailure> {
  readonly handle: Handle;
  readonly input: NanoclawProcessInput;
  readonly observation: ProcessObservation<WaitFailure>;
}

function acquireNanoclawProcess<
  Name extends string,
  Install,
  Handle,
  WaitFailure,
  Requirements,
>(
  settings: NanoclawRuntimeSettings,
  driver: NanoclawRuntimeDriver<Install, Handle, WaitFailure, Requirements>,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  AcquiredNanoclawProcess<Handle, WaitFailure>,
  NanoclawRuntimeAcquisitionError,
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
    const install = yield* driver
      .install(installMode)
      .pipe(
        Effect.mapError((cause) =>
          acquisitionFailure(process.agentName, "install runtime", cause),
        ),
      );
    const handle = yield* startProcessScoped(process, install, driver);
    const observation: ProcessObservation<WaitFailure> = {
      exitCode: driver.exitCode(handle),
      output: () => driver.output(handle),
    };
    return { handle, input: process, observation };
  });
}

function connectionWithGatewayReadiness<Name extends string>(
  connection: AgentConnection<Name>,
  gatewayReady: Deferred.Deferred<NanoclawGatewaySession, unknown>,
): AgentConnection<Name> {
  return {
    ...connection,
    awaitReady: (within) =>
      Effect.all(
        [
          connection.awaitReady(within),
          Deferred.await(gatewayReady).pipe(
            Effect.mapError((cause) =>
              NetworkFailure.make({
                operation: "socket",
                detail: String(cause),
              }),
            ),
            Effect.asVoid,
          ),
        ],
        { concurrency: 2, discard: true },
      ),
  };
}

function awaitNanoclawGateway<
  Name extends string,
  Handle,
  WaitFailure,
  Requirements,
>(
  process: AcquiredNanoclawProcess<Handle, WaitFailure>,
  connection: AgentConnection<Name>,
  within: Duration.Duration,
  acquireGateway: NanoclawGatewayAcquirer<Handle, Requirements>,
): Effect.Effect<
  NanoclawGatewaySession,
  NanoclawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  return Effect.gen(function* () {
    const gatewayReady = yield* Deferred.make<
      NanoclawGatewaySession,
      unknown
    >();
    yield* acquireGateway(process.handle, within).pipe(
      Effect.intoDeferred(gatewayReady),
      Effect.forkScoped,
    );
    yield* awaitProcessReady({
      connection: connectionWithGatewayReadiness(connection, gatewayReady),
      within,
      agentName: process.input.agentName,
      agentKey: process.input.apiKey,
      runtimeName: NANOCLAW_RUNTIME_NAME,
      observation: process.observation,
    });
    return yield* Deferred.await(gatewayReady).pipe(
      Effect.mapError((cause) =>
        acquisitionFailure(
          process.input.agentName,
          "connect principal gateway",
          cause,
        ),
      ),
    );
  });
}

function nanoclawTermination<Handle, WaitFailure>(
  process: AcquiredNanoclawProcess<Handle, WaitFailure>,
  gateway: NanoclawGatewaySession,
): Effect.Effect<RuntimeTermination> {
  const gatewayTermination = gateway.failure.pipe(
    Effect.catchAll((cause) =>
      Effect.succeed(
        RuntimeFailed.make({
          detail: `NanoClaw principal gateway for agent "${process.input.agentName}" disconnected: ${String(cause)}`,
        }),
      ),
    ),
  );
  return Effect.raceFirst(
    processTermination(
      {
        agentName: process.input.agentName,
        runtimeName: NANOCLAW_RUNTIME_NAME,
      },
      process.observation,
    ),
    gatewayTermination,
  );
}

function acquireNanoclawRuntime<
  Name extends string,
  Install,
  Handle,
  WaitFailure,
  Requirements,
>(
  settings: NanoclawRuntimeSettings,
  driver: NanoclawRuntimeDriver<Install, Handle, WaitFailure, Requirements>,
  input: AgentRuntimeInput<Name>,
): Effect.Effect<
  RunningAgent<NanoclawGateway>,
  NanoclawRuntimeAcquisitionError,
  Scope.Scope | Requirements
> {
  return Effect.gen(function* () {
    const process = yield* acquireNanoclawProcess(settings, driver, input);
    const gateway = yield* awaitNanoclawGateway(
      process,
      input.connection,
      settings.startupTimeout,
      driver.gateway,
    );
    return {
      gateway: gateway.gateway,
      termination: nanoclawTermination(process, gateway),
    };
  }).pipe(
    Effect.withSpan("nanoclawRuntime.acquire", {
      attributes: {
        "agent.name": input.connection.agent.name,
        "runtime.name": NANOCLAW_RUNTIME_NAME,
      },
    }),
  );
}

/**
 * Build NanoClaw's process-backed runtime against an explicit low-level driver.
 * Production uses {@link nanoclawRuntime}; this seam keeps lifecycle tests
 * free of Docker and immutable-install work.
 * @param options Options that control the operation.
 * @param driver Value supplied to the operation.
 * @internal
 * @returns The created nanoclaw runtime with.
 */
export function makeNanoclawRuntimeWith<
  Install,
  Handle,
  WaitFailure = unknown,
  Requirements = never,
>(
  options: NanoclawRuntimeOptions,
  driver: NanoclawRuntimeDriver<Install, Handle, WaitFailure, Requirements>,
): AgentRuntime<
  NanoclawGateway,
  NanoclawRuntimeAcquisitionError,
  Requirements,
  typeof NanoclawRuntimeConfiguration
> {
  const settings = snapshotOptions(options);
  return defineRuntime({
    name: NANOCLAW_RUNTIME_NAME,
    configuration: {
      schema: NanoclawRuntimeConfiguration,
      value: runtimeConfiguration(settings),
    },
    acquire: (input) => acquireNanoclawRuntime(settings, driver, input),
  });
}

/**
 * Construct a NanoClaw runtime that binds each roster identity to one
 * scoped container-backed process and waits for router-visible readiness.
 * @param options Options that control the operation.
 * @returns The nanoclaw runtime result.
 */
export function nanoclawRuntime(
  options: NanoclawRuntimeOptions = {},
): AgentRuntime<
  NanoclawGateway,
  NanoclawRuntimeAcquisitionError,
  NanoclawHostServices,
  typeof NanoclawRuntimeConfiguration
> {
  return makeNanoclawRuntimeWith(options, nativeNanoclawDriver);
}
