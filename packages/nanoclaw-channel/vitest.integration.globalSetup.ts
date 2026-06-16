/**
 * Global setup for integration tests.
 *
 * Pattern: sbd#182 spike (evidence in
 * `safer-by-default/spike/moltzap-headless-ci-fixture/probe.mjs`).
 * Spawns `packages/server/dist/standalone.js` with PGlite (no external
 * Postgres, no docker). Registers two agents so the echo test can boot a
 * channel as agent A and drive inbound traffic via an in-process MoltZap
 * client as agent B. Provides WS URL + per-agent API keys + agent IDs to
 * the test via vitest `provide()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { execPath } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  FetchHttpClient,
  FileSystem,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { type RegisterResponse } from "@moltzap/client/auth";
import { registerStandaloneAgentPair } from "@moltzap/client/test-utils";
import {
  Config,
  ConfigProvider,
  Data,
  Duration,
  Effect,
  Redacted,
} from "effect";
import type { GlobalSetupContext } from "vitest/node";

const DEFAULT_READY_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_DELAY_MS = 100;
const STOP_TIMEOUT_MS = 5_000;
// Distinct port range from openclaw (41_490-41_740) and claude-code
// (41_990-42_240) so parallel package test runs do not collide.
const MIN_TEST_PORT = 42_240;
const MAX_TEST_PORT_EXCLUSIVE = 42_490;
const TEMP_DIR_PREFIX = "nanoclaw-integration-";
const READY_TIMEOUT_CONFIG = "NANOCLAW_CHANNEL_INTEGRATION_READY_TIMEOUT_MS";

let child: ChildProcess | null = null;
let tempDir: string | null = null;

class IntegrationSetupError extends Data.TaggedError(
  "NanoclawChannelIntegrationSetupError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type OutputCapture = {
  stdout: string;
  stderr: string;
};

type StandaloneProcess = {
  readonly child: ChildProcess;
  readonly output: OutputCapture;
  readonly getExit: () => ChildExit | null;
};

export default function ({ provide }: GlobalSetupContext) {
  return Effect.runPromise(setupIntegrationTests(provide));
}

function setupIntegrationTests(provide: GlobalSetupContext["provide"]) {
  return Effect.gen(function* () {
    const port = pickPort();
    const paths = yield* makeStandalonePaths(port);
    const standalone = yield* startStandalone(paths, port);
    const baseUrl = `http://localhost:${port}`;
    yield* waitForStandaloneReady(standalone, baseUrl);
    const { first: agentA, second: agentB } =
      yield* registerStandaloneAgentPair(baseUrl, {
        first: "channel-agent-a",
        second: "peer-agent-b",
      });
    provideIntegrationValues(provide, port, agentA, agentB);
    return () => Effect.runPromise(teardownIntegrationTests());
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeFileSystem.layer),
  );
}

function pickPort(): number {
  return randomInt(MIN_TEST_PORT, MAX_TEST_PORT_EXCLUSIVE);
}

function readReadyTimeoutMs(): Effect.Effect<number> {
  return Config.integer(READY_TIMEOUT_CONFIG).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.map((value) => (value > 0 ? value : DEFAULT_READY_TIMEOUT_MS)),
    Effect.orElseSucceed(() => DEFAULT_READY_TIMEOUT_MS),
  );
}

function makeStandalonePaths(port: number): Effect.Effect<
  {
    readonly moltzapRoot: string;
    readonly standalone: string;
    readonly configPath: string;
  },
  IntegrationSetupError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const here = dirname(fileURLToPath(import.meta.url));
    const moltzapRoot = resolve(here, "..", "..");
    const standalone = join(
      moltzapRoot,
      "packages",
      "server",
      "dist",
      "standalone.js",
    );
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem
      .makeTempDirectory({ prefix: TEMP_DIR_PREFIX })
      .pipe(
        Effect.mapError((cause) =>
          setupError("create temp config directory", cause),
        ),
      );
    tempDir = dir;
    const configPath = join(dir, "moltzap.yaml");
    yield* fileSystem
      .writeFileString(configPath, configBody(port))
      .pipe(
        Effect.mapError((cause) =>
          setupError("write standalone config", cause),
        ),
      );
    return { moltzapRoot, standalone, configPath };
  });
}

function configBody(port: number): string {
  return `server:\n  port: ${port}\n  cors_origins: ["*"]\nlog_level: warn\n`;
}

function startStandalone(
  paths: {
    readonly moltzapRoot: string;
    readonly standalone: string;
    readonly configPath: string;
  },
  port: number,
): Effect.Effect<StandaloneProcess, IntegrationSetupError> {
  return Effect.try({
    try: () => {
      const output: OutputCapture = { stdout: "", stderr: "" };
      let childExit: ChildExit | null = null;
      const spawned = spawn(execPath, [paths.standalone], {
        cwd: paths.moltzapRoot,
        env: standaloneEnv(paths.configPath, port),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      spawned.stdout?.on("data", (data: Buffer) => {
        output.stdout += data.toString();
      });
      spawned.stderr?.on("data", (data: Buffer) => {
        output.stderr += data.toString();
      });
      spawned.once("exit", (code, signal) => {
        childExit = { code, signal };
      });
      return { child: spawned, output, getExit: () => childExit };
    },
    catch: (cause) =>
      new IntegrationSetupError({ operation: "spawn standalone", cause }),
  });
}

function standaloneEnv(configPath: string, port: number): NodeJS.ProcessEnv {
  return {
    MOLTZAP_CONFIG: configPath,
    MOLTZAP_ADMIN_USER_ID: "00000000-0000-4000-8000-000000000001",
    MOLTZAP_DEV_MODE: "true",
    PORT: String(port),
    ENCRYPTION_MASTER_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  };
}

function waitForStandaloneReady(
  standalone: StandaloneProcess,
  baseUrl: string,
): Effect.Effect<void, IntegrationSetupError> {
  return Effect.gen(function* () {
    const readyTimeoutMs = yield* readReadyTimeoutMs();
    const deadline = performance.now() + readyTimeoutMs;
    while (performance.now() < deadline) {
      yield* failIfExited(standalone);
      if (yield* probeReady(baseUrl)) return;
      yield* Effect.sleep(`${PROBE_DELAY_MS} millis`);
    }
    standalone.child.kill("SIGKILL");
    return yield* Effect.fail(
      setupError(
        "wait for standalone readiness",
        `moltzap standalone did not become ready within ${readyTimeoutMs}ms. ${standaloneOutput(standalone.output)}`,
      ),
    );
  });
}

function failIfExited(
  standalone: StandaloneProcess,
): Effect.Effect<void, IntegrationSetupError> {
  const childExit = standalone.getExit();
  return childExit === null
    ? Effect.void
    : Effect.fail(
        setupError(
          "wait for standalone readiness",
          `moltzap standalone exited before readiness (code=${childExit.code}, signal=${childExit.signal}). ${standaloneOutput(standalone.output)}`,
        ),
      );
}

function probeReady(
  baseUrl: string,
): Effect.Effect<boolean, never, HttpClient.HttpClient> {
  return HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.options(`${baseUrl}/api/v1/auth/register`),
      ),
    ),
    Effect.timeoutTo({
      duration: Duration.millis(PROBE_TIMEOUT_MS),
      onSuccess: (response) => response.status < 500,
      onTimeout: () => false,
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

function provideIntegrationValues(
  provide: GlobalSetupContext["provide"],
  port: number,
  agentA: RegisterResponse,
  agentB: RegisterResponse,
): void {
  provide("moltzapBaseUrl", `http://localhost:${port}`);
  provide("moltzapWsUrl", `ws://localhost:${port}`);
  provide("agentAAgentId", agentA.agentId);
  provide("agentAApiKey", Redacted.value(agentA.apiKey));
  provide("agentBAgentId", agentB.agentId);
  provide("agentBApiKey", Redacted.value(agentB.apiKey));
}

function teardownIntegrationTests(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const current = child;
    child = null;
    if (current !== null) yield* stopChild(current);
    yield* removeTempDir;
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.ignore);
}

function stopChild(process: ChildProcess): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resume(Effect.void);
    }, STOP_TIMEOUT_MS);
    process.once("exit", () => {
      clearTimeout(timer);
      resume(Effect.void);
    });
    process.kill("SIGTERM");
  });
}

const removeTempDir: Effect.Effect<void, unknown, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const current = tempDir;
    tempDir = null;
    if (current === null) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(current, { recursive: true, force: true });
  });

function tail(text: string): string {
  const lines = text.split("\n").filter((line) => line.length > 0);
  return lines.slice(-20).join("\n");
}

function standaloneOutput(output: OutputCapture): string {
  return `stdout tail:\n${tail(output.stdout)}\nstderr tail:\n${tail(output.stderr)}`;
}

function setupError(operation: string, cause: unknown): IntegrationSetupError {
  return new IntegrationSetupError({ operation, cause });
}
