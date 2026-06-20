/**
 * Shared Docker container management for OpenClaw integration tests and evals.
 * Both test tiers import from here to avoid duplicating config-building and lifecycle logic.
 */

import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Redacted } from "effect";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";

const CONTROL_UI_PORT = 18789;
const OPENCLAW_TOKEN_RADIX = 36;
const DEFAULT_PORT_RANGE_START = 19000;
const DEFAULT_PORT_RANGE_END = 19999;
const JSON_INDENT_SPACES = 2;
const MS_PER_SECOND = 1000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const GATEWAY_READY_PATTERN = "[gateway]";
const CHANNEL_READY_PATTERNS = ["[moltzap]", "connected as"] as const;
const DOCKER_BIN = "/usr/bin/docker";

const IMAGE_NAME = "moltzap-eval-agent:local";
const OPENCLAW_STATE_DIR = "/home/node/.openclaw";

class OpenClawContainerError extends Error {
  override readonly name = "OpenClawContainerError";
}

interface StartContainerOptions {
  readonly name: string;
  readonly agentName: string;
  readonly moltzapProfile?: {
    readonly agentId: AgentId;
    readonly apiKey: AgentKey;
  };
  readonly envVars?: Record<string, string>;
  readonly portRange?: [number, number];
}

interface LogWaitState {
  readonly containerId: string;
  readonly required: readonly string[];
  readonly matched: Set<string>;
  readonly proc: ChildProcessWithoutNullStreams;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
  buffer: string;
}

function logContainerHelperFailure(action: string, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  Effect.runFork(
    Effect.logWarning(`[openclaw-container] ${action}: ${message}`),
  );
}

function logContainerHelperFailureEffect(action: string, cause: unknown) {
  return Effect.sync(() => logContainerHelperFailure(action, cause));
}

export type ContainerModelConfig = {
  modelString: string;
  providerConfig?: {
    provider: string;
    modelId: string;
    baseUrl: string;
    api: string;
    apiKey: Redacted.Redacted<string>;
  };
};

export type OpenClawContainer = {
  containerId: string;
  controlPort: number;
  tmpDir: string;
};

export function isImageAvailable(): boolean {
  try {
    execFileSync(DOCKER_BIN, ["image", "inspect", IMAGE_NAME], {
      stdio: "pipe",
    });
    return true;
  } catch (cause) {
    logContainerHelperFailure("docker image inspect failed", cause);
    return false;
  }
}

interface BuildOpenClawConfigOptions {
  model: ContainerModelConfig;
  agentName: string;
}

export function normalizeContainerServerUrl(serverUrl: string): string {
  return serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace("localhost", "host.docker.internal")
    .replace("127.0.0.1", "host.docker.internal");
}

function baseOpenClawConfig(
  opts: BuildOpenClawConfigOptions,
): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        model: { primary: opts.model.modelString },
        workspace: `${OPENCLAW_STATE_DIR}/workspace`,
        compaction: { mode: "safeguard" },
      },
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: true,
      ownerDisplay: "raw",
    },
    messages: {
      // Keep one inbound -> one outbound behavior in integration tests.
      queue: { mode: "queue", debounceMs: 0, cap: 100, drop: "new" },
    },
    channels: {
      moltzap: {
        accounts: [
          {
            id: opts.agentName,
            agentName: opts.agentName,
          },
        ],
      },
    },
    gateway: {
      mode: "local",
      controlUi: {
        dangerouslyAllowHostHeaderOriginFallback: true,
        dangerouslyDisableDeviceAuth: true,
      },
      auth: {
        mode: "token",
        token: `e2e-${Date.now().toString(OPENCLAW_TOKEN_RADIX)}`,
      },
    },
    meta: {
      lastTouchedVersion: "2026.3.14",
      lastTouchedAt: new Date().toISOString(),
    },
  };
}

function providerModelsConfig(
  providerConfig: NonNullable<ContainerModelConfig["providerConfig"]>,
) {
  return {
    models: {
      providers: {
        [providerConfig.provider]: {
          baseUrl: providerConfig.baseUrl,
          api: providerConfig.api,
          apiKey: Redacted.value(providerConfig.apiKey),
          models: [
            { id: providerConfig.modelId, name: providerConfig.modelId },
          ],
        },
      },
    },
  };
}

/** Build openclaw.json config for a container. */
export function buildOpenClawConfig(
  opts: BuildOpenClawConfigOptions,
): Record<string, unknown> {
  const config = baseOpenClawConfig(opts);
  return opts.model.providerConfig
    ? { ...config, ...providerModelsConfig(opts.model.providerConfig) }
    : config;
}

/** Create, configure, and start an OpenClaw Docker container. */
export function startRawContainer(
  config: Record<string, unknown>,
  opts: StartContainerOptions,
): Effect.Effect<OpenClawContainer, unknown, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.gen(function* () {
        const tmpDir = yield* createContainerFiles(fileSystem, config, opts);
        const controlPort = allocateControlPort(opts);
        const containerId = createContainerProcess(opts, controlPort);
        copyAndStartContainer(containerId, tmpDir);
        chownContainerState(containerId);
        return { containerId, controlPort, tmpDir };
      }),
    ),
    Effect.withSpan("startRawContainer"),
    Effect.provide(NodeFileSystem.layer),
  );
}

function createContainerFiles(
  fileSystem: FileSystem.FileSystem,
  config: Record<string, unknown>,
  opts: StartContainerOptions,
) {
  return Effect.gen(function* () {
    const tmpDir = yield* fileSystem.makeTempDirectory({
      directory: os.tmpdir(),
      prefix: "openclaw-e2e-",
    });
    yield* fileSystem.writeFileString(
      path.join(tmpDir, "openclaw.json"),
      JSON.stringify(config, null, JSON_INDENT_SPACES),
    );
    yield* createContainerSubdirectories(fileSystem, tmpDir);
    yield* writeContainerMoltZapConfig(fileSystem, tmpDir, opts);
    yield* fileSystem.writeFileString(
      path.join(tmpDir, "workspace", "IDENTITY.md"),
      `---\nName: ${opts.agentName}\nCreature: AI agent\nVibe: helpful\n---\n`,
    );
    return tmpDir;
  });
}

function createContainerSubdirectories(
  fileSystem: FileSystem.FileSystem,
  tmpDir: string,
) {
  return Effect.all(
    ["workspace", "logs", ".moltzap"].map((sub) =>
      fileSystem.makeDirectory(path.join(tmpDir, sub), { recursive: true }),
    ),
    { concurrency: 2 },
  );
}

function writeContainerMoltZapConfig(
  fileSystem: FileSystem.FileSystem,
  tmpDir: string,
  opts: StartContainerOptions,
) {
  if (opts.moltzapProfile === undefined) return Effect.void;
  return fileSystem.writeFileString(
    path.join(tmpDir, ".moltzap", "config.json"),
    JSON.stringify(
      {
        profiles: {
          [opts.agentName]: {
            agentId: opts.moltzapProfile.agentId,
            apiKey: Redacted.value(opts.moltzapProfile.apiKey),
            agentName: opts.agentName,
          },
        },
      },
      null,
      JSON_INDENT_SPACES,
    ),
  );
}

function allocateControlPort(opts: StartContainerOptions): number {
  const [lo, hi] = opts.portRange ?? [
    DEFAULT_PORT_RANGE_START,
    DEFAULT_PORT_RANGE_END,
  ];
  return randomInt(lo, hi);
}

function containerEnvArgs(envVars: Record<string, string> | undefined) {
  const envParts = [
    "-e",
    `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}`,
    "-e",
    `MOLTZAP_CONFIG_HOME=${OPENCLAW_STATE_DIR}/.moltzap`,
  ];
  for (const [key, value] of Object.entries(envVars ?? {})) {
    envParts.push("-e", `${key}=${value}`);
  }
  return envParts;
}

function createContainerProcess(
  opts: StartContainerOptions,
  controlPort: number,
): string {
  return execFileSync(DOCKER_BIN, createContainerArgs(opts, controlPort), {
    encoding: "utf-8",
  }).trim();
}

function createContainerArgs(
  opts: StartContainerOptions,
  controlPort: number,
): string[] {
  const containerName = `moltzap-e2e-${opts.name}-${Date.now()}`;
  const startedEpoch = Math.floor(Date.now() / MS_PER_SECOND);
  return [
    "create",
    "--name",
    containerName,
    "--label",
    "moltzap-eval=true",
    "--label",
    `moltzap-eval-started=${startedEpoch}`,
    "--stop-timeout",
    "5",
    ...containerEnvArgs(opts.envVars),
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `${controlPort}:${CONTROL_UI_PORT}`,
    IMAGE_NAME,
    "node",
    "openclaw.mjs",
    "gateway",
    "run",
    "--allow-unconfigured",
    "--bind",
    "lan",
  ];
}

function copyAndStartContainer(containerId: string, tmpDir: string): void {
  execFileSync(DOCKER_BIN, [
    "cp",
    `${tmpDir}/.`,
    `${containerId}:${OPENCLAW_STATE_DIR}/`,
  ]);
  execFileSync(DOCKER_BIN, ["start", containerId]);
}

function chownContainerState(containerId: string): void {
  execFileSync(DOCKER_BIN, [
    "exec",
    "-u",
    "root",
    containerId,
    "chown",
    "node:node",
    `${OPENCLAW_STATE_DIR}/openclaw.json`,
  ]);
  execFileSync(DOCKER_BIN, [
    "exec",
    "-u",
    "root",
    containerId,
    "chown",
    "-R",
    "node:node",
    `${OPENCLAW_STATE_DIR}/workspace`,
    `${OPENCLAW_STATE_DIR}/logs`,
    `${OPENCLAW_STATE_DIR}/.moltzap`,
  ]);
}

export function getLogs(containerId: string): string {
  try {
    return execFileSync(DOCKER_BIN, ["logs", containerId], {
      encoding: "utf-8",
    });
  } catch (cause) {
    logContainerHelperFailure("docker logs failed", cause);
    return "";
  }
}

/** Stream `docker logs -f` and resolve when all patterns appear. */
function waitForLogMatch(
  containerId: string,
  patterns: string | string[],
  timeoutMs: number,
) {
  const required = Array.isArray(patterns) ? patterns : [patterns];

  return new Promise<void>((resolve, reject) => {
    const inspectFailure = inspectContainerForLogStream(containerId);
    if (inspectFailure) {
      reject(inspectFailure);
      return;
    }
    const proc = spawn(DOCKER_BIN, ["logs", "-f", containerId]);
    const timer = setTimeout(() => {
      failLogWait(state, logMatchTimeoutError(state, timeoutMs));
    }, timeoutMs);
    const state: LogWaitState = {
      containerId,
      required,
      matched: new Set<string>(),
      proc,
      timer,
      resolve,
      reject,
      settled: false,
      buffer: "",
    };
    wireLogWaitProcess(state);
  });
}

function inspectContainerForLogStream(
  containerId: string,
): OpenClawContainerError | undefined {
  try {
    const status = execFileSync(
      DOCKER_BIN,
      ["inspect", containerId, "--format={{.State.Status}}"],
      { encoding: "utf-8" },
    ).trim();
    return status === "running"
      ? undefined
      : new OpenClawContainerError(
          `Container not running (status: ${status}) before log stream.\nLogs:\n${getLogs(containerId)}`,
        );
  } catch (cause) {
    return new OpenClawContainerError(
      `Failed to inspect container ${containerId}: ${String(cause)}`,
    );
  }
}

function wireLogWaitProcess(state: LogWaitState): void {
  state.proc.stdout.on("data", (chunk: Buffer) =>
    processLogChunk(state, chunk),
  );
  state.proc.stderr.on("data", (chunk: Buffer) =>
    processLogChunk(state, chunk),
  );
  state.proc.on("error", (err) => {
    failLogWait(
      state,
      new OpenClawContainerError(
        `docker logs process error: ${err.message}\nLogs:\n${getLogs(state.containerId)}`,
      ),
    );
  });
  state.proc.on("close", (code) => handleLogStreamClose(state, code));
}

function processLogChunk(state: LogWaitState, chunk: Buffer): void {
  state.buffer += chunk.toString();
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    addLineMatches(state, line);
    if (allPatternsMatched(state)) {
      succeedLogWait(state);
      return;
    }
  }
}

function addLineMatches(state: LogWaitState, line: string): void {
  for (const pattern of state.required) {
    if (!state.matched.has(pattern) && line.includes(pattern)) {
      state.matched.add(pattern);
    }
  }
}

function handleLogStreamClose(state: LogWaitState, code: number | null): void {
  if (state.settled) return;
  addBufferMatches(state);
  if (allPatternsMatched(state)) {
    succeedLogWait(state);
    return;
  }
  const exitCode = code ?? "unknown";
  failLogWait(state, logMatchExitError(state, exitCode));
}

function addBufferMatches(state: LogWaitState): void {
  if (state.buffer.length === 0) return;
  for (const pattern of state.required) {
    if (state.buffer.includes(pattern)) state.matched.add(pattern);
  }
}

function allPatternsMatched(state: LogWaitState): boolean {
  return state.matched.size === state.required.length;
}

function succeedLogWait(state: LogWaitState): void {
  finishLogWait(state);
  state.resolve();
}

function failLogWait(state: LogWaitState, error: Error): void {
  finishLogWait(state);
  state.reject(error);
}

function finishLogWait(state: LogWaitState): void {
  if (state.settled) return;
  state.settled = true;
  clearTimeout(state.timer);
  state.proc.kill();
}

function missingPatterns(state: LogWaitState): string[] {
  return state.required.filter((pattern) => !state.matched.has(pattern));
}

function logMatchTimeoutError(
  state: LogWaitState,
  timeoutMs: number,
): OpenClawContainerError {
  return new OpenClawContainerError(
    `waitForLogMatch timed out after ${timeoutMs}ms.\n` +
      logMatchStateSummary(state),
  );
}

function logMatchExitError(
  state: LogWaitState,
  code: number | "unknown",
): OpenClawContainerError {
  return new OpenClawContainerError(
    `docker logs exited (code ${code}) before all patterns matched.\n` +
      logMatchStateSummary(state),
  );
}

function logMatchStateSummary(state: LogWaitState): string {
  return (
    `Matched: [${[...state.matched].join(", ")}]\n` +
    `Missing: [${missingPatterns(state).join(", ")}]\n` +
    `Logs:\n${getLogs(state.containerId)}`
  );
}

/** Wait for both gateway and channel to be ready (single log stream). */
export function waitForReady(containerId: string) {
  return waitForLogMatch(
    containerId,
    [GATEWAY_READY_PATTERN, ...CHANNEL_READY_PATTERNS],
    DEFAULT_READY_TIMEOUT_MS,
  );
}

/** Stop and remove a container, clean up temp files. */
export function stopContainer(
  container: OpenClawContainer,
): Effect.Effect<void, never, never> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.gen(function* () {
        try {
          execFileSync(DOCKER_BIN, ["rm", "-f", container.containerId], {
            stdio: "pipe",
          });
        } catch (cause) {
          logContainerHelperFailure("docker rm failed during cleanup", cause);
        }
        yield* removeTempDir(fileSystem, container.tmpDir);
      }),
    ),
    Effect.withSpan("stopContainer"),
    Effect.provide(NodeFileSystem.layer),
    Effect.catchAll((cause) =>
      logContainerHelperFailureEffect(
        "temporary directory cleanup failed",
        cause,
      ),
    ),
  );
}

function removeTempDir(
  fileSystem: FileSystem.FileSystem,
  tmpDir: string,
): Effect.Effect<void, never> {
  return fileSystem
    .remove(tmpDir, { recursive: true, force: true })
    .pipe(
      Effect.catchAll((cause) =>
        logContainerHelperFailureEffect(
          "temporary directory cleanup failed",
          cause,
        ),
      ),
    );
}
