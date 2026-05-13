/**
 * Shared Docker container management for OpenClaw integration tests and evals.
 * Both test tiers import from here to avoid duplicating config-building and lifecycle logic.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONTROL_UI_PORT = 18789;
const OPENCLAW_TOKEN_RADIX = 36;
const DEFAULT_PORT_RANGE_START = 19000;
const DEFAULT_PORT_RANGE_END = 19999;
const JSON_INDENT_SPACES = 2;
const MS_PER_SECOND = 1000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;
const DEFAULT_CHANNEL_TIMEOUT_MS = 180_000;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const GATEWAY_READY_PATTERN = "[gateway]";
const CHANNEL_READY_PATTERNS = ["[moltzap]", "connected as"] as const;
const DOCKER_BIN = "/usr/bin/docker";

export const IMAGE_NAME = "moltzap-eval-agent:local";
export const OPENCLAW_STATE_DIR = "/home/node/.openclaw";

class OpenClawContainerError extends Error {
  override readonly name = "OpenClawContainerError";
}

function logContainerHelperFailure(action: string, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.warn(`[openclaw-container] ${action}: ${message}`);
}

export type ContainerModelConfig = {
  modelString: string;
  providerConfig?: {
    provider: string;
    modelId: string;
    baseUrl: string;
    api: string;
    apiKey: string;
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

/** Build openclaw.json config for a container. */
export function buildOpenClawConfig(opts: {
  model: ContainerModelConfig;
  serverUrl: string;
  agentApiKey: string;
  agentName: string;
}): Record<string, unknown> {
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace("localhost", "host.docker.internal")
    .replace("127.0.0.1", "host.docker.internal");

  const config: Record<string, unknown> = {
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
            id: "default",
            apiKey: opts.agentApiKey,
            serverUrl,
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

  if (opts.model.providerConfig) {
    const pc = opts.model.providerConfig;
    (config as Record<string, Record<string, unknown>>).models = {
      providers: {
        [pc.provider]: {
          baseUrl: pc.baseUrl,
          api: pc.api,
          apiKey: pc.apiKey,
          models: [{ id: pc.modelId, name: pc.modelId }],
        },
      },
    };
  }

  return config;
}

/** Create, configure, and start an OpenClaw Docker container. */
export function startRawContainer(
  config: Record<string, unknown>,
  opts: {
    name: string;
    agentName: string;
    envVars?: Record<string, string>;
    portRange?: [number, number];
  },
): OpenClawContainer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-"));
  const [lo, hi] = opts.portRange ?? [
    DEFAULT_PORT_RANGE_START,
    DEFAULT_PORT_RANGE_END,
  ];
  const controlPort = randomInt(lo, hi);

  fs.writeFileSync(
    path.join(tmpDir, "openclaw.json"),
    JSON.stringify(config, null, JSON_INDENT_SPACES),
  );
  for (const sub of ["workspace", "logs"]) {
    fs.mkdirSync(path.join(tmpDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(tmpDir, "workspace", "IDENTITY.md"),
    `---\nName: ${opts.agentName}\nCreature: AI agent\nVibe: helpful\n---\n`,
  );

  const containerName = `moltzap-e2e-${opts.name}-${Date.now()}`;
  const startedEpoch = Math.floor(Date.now() / MS_PER_SECOND);
  const envParts = ["-e", `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}`];
  if (opts.envVars) {
    for (const [k, v] of Object.entries(opts.envVars)) {
      envParts.push("-e", `${k}=${v}`);
    }
  }

  const containerId = execFileSync(
    DOCKER_BIN,
    [
      "create",
      "--name",
      containerName,
      "--label",
      "moltzap-eval=true",
      "--label",
      `moltzap-eval-started=${startedEpoch}`,
      "--stop-timeout",
      "5",
      ...envParts,
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
    ],
    { encoding: "utf-8" },
  ).trim();

  execFileSync(DOCKER_BIN, [
    "cp",
    `${tmpDir}/.`,
    `${containerId}:${OPENCLAW_STATE_DIR}/`,
  ]);
  execFileSync(DOCKER_BIN, ["start", containerId]);
  // Only chown the files we copied; recursively chowning the entire state dir
  // is much slower because the eval image already contains plugin dependencies.
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
  ]);

  return { containerId, controlPort, tmpDir };
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
export function waitForLogMatch(
  containerId: string,
  patterns: string | string[],
  timeoutMs: number,
) {
  const required = Array.isArray(patterns) ? patterns : [patterns];

  return new Promise<void>((resolve, reject) => {
    // Pre-flight: verify the container is still running before streaming.
    try {
      const status = execFileSync(
        DOCKER_BIN,
        ["inspect", containerId, "--format={{.State.Status}}"],
        {
          encoding: "utf-8",
        },
      ).trim();
      if (status !== "running") {
        reject(
          new OpenClawContainerError(
            `Container not running (status: ${status}) before log stream.\nLogs:\n${getLogs(containerId)}`,
          ),
        );
        return;
      }
    } catch (err) {
      reject(
        new OpenClawContainerError(
          `Failed to inspect container ${containerId}: ${err instanceof Error ? err.message : err}`,
        ),
      );
      return;
    }

    const matched = new Set<string>();
    let settled = false;
    let buffer = "";

    const proc = spawn(DOCKER_BIN, ["logs", "-f", containerId]);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
    };
    const finishSuccess = () => {
      finish();
      resolve();
    };
    const finishFailure = (error: Error) => {
      finish();
      reject(error);
    };

    const timer = setTimeout(() => {
      const missing = required.filter((p) => !matched.has(p));
      finishFailure(
        new OpenClawContainerError(
          `waitForLogMatch timed out after ${timeoutMs}ms.\n` +
            `Matched: [${[...matched].join(", ")}]\n` +
            `Missing: [${missing.join(", ")}]\n` +
            `Logs:\n${getLogs(containerId)}`,
        ),
      );
    }, timeoutMs);

    const processData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer.
      buffer = lines.pop()!;
      for (const line of lines) {
        for (const pattern of required) {
          if (!matched.has(pattern) && line.includes(pattern))
            matched.add(pattern);
        }
        if (matched.size === required.length) {
          finishSuccess();
          return;
        }
      }
    };

    // docker logs writes to stderr by default, but listen on both to be safe.
    proc.stdout.on("data", processData);
    proc.stderr.on("data", processData);

    proc.on("error", (err) => {
      finishFailure(
        new OpenClawContainerError(
          `docker logs process error: ${err.message}\nLogs:\n${getLogs(containerId)}`,
        ),
      );
    });

    proc.on("close", (code) => {
      if (!settled) {
        // Process exited before all patterns matched — check remaining buffer.
        if (buffer.length > 0) {
          for (const pattern of required) {
            if (buffer.includes(pattern)) matched.add(pattern);
          }
          if (matched.size === required.length) {
            finishSuccess();
            return;
          }
        }
        const missing = required.filter((p) => !matched.has(p));
        finishFailure(
          new OpenClawContainerError(
            `docker logs exited (code ${code}) before all patterns matched.\n` +
              `Matched: [${[...matched].join(", ")}]\n` +
              `Missing: [${missing.join(", ")}]\n` +
              `Logs:\n${getLogs(containerId)}`,
          ),
        );
      }
    });
  });
}

/** Wait for the OpenClaw gateway process to start. */
export function waitForGateway(
  containerId: string,
  timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
) {
  return waitForLogMatch(containerId, GATEWAY_READY_PATTERN, timeoutMs);
}

/** Wait for the MoltZap channel to connect within the container. */
export function waitForChannel(
  containerId: string,
  timeoutMs = DEFAULT_CHANNEL_TIMEOUT_MS,
) {
  return waitForLogMatch(containerId, [...CHANNEL_READY_PATTERNS], timeoutMs);
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
export function stopContainer(container: OpenClawContainer): void {
  try {
    execFileSync(DOCKER_BIN, ["rm", "-f", container.containerId], {
      stdio: "pipe",
    });
  } catch (cause) {
    logContainerHelperFailure("docker rm failed during cleanup", cause);
  }
  try {
    fs.rmSync(container.tmpDir, { recursive: true, force: true });
  } catch (cause) {
    logContainerHelperFailure("temporary directory cleanup failed", cause);
  }
}
