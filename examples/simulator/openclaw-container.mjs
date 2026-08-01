/** @file Local Linux container launcher for the original simulator example. */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import imageConfig from "./openclaw-image.json" with { type: "json" };

const LABEL_PREFIX = "com.moltzap.simulator";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const OPENCLAW_ENTRYPOINT = "/app/openclaw.mjs";
const CONTAINER_STOP_TIMEOUT_MS = 5_000;
const CONTAINER_REMOVE_ATTEMPTS = 3;
const SAFE_LABEL_VALUE = /^[A-Za-z0-9_.-]+$/u;
const MISSING_CONTAINER = /No such (?:container|object)/u;

const REQUIRED_RUNTIME_ENVIRONMENT = [
  "HOME",
  "MOLTZAP_CONFIG_HOME",
  "MOLTZAP_SERVER_URL",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
];

const READ_ONLY_MOUNTS = [
  join(REPOSITORY_ROOT, "node_modules"),
  join(REPOSITORY_ROOT, "packages", "client"),
  join(REPOSITORY_ROOT, "packages", "openclaw-channel"),
  join(REPOSITORY_ROOT, "packages", "protocol"),
];

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`container launcher requires ${name}`);
  }
  return value;
}

function safeLabelValue(value, description) {
  if (!SAFE_LABEL_VALUE.test(value)) {
    throw new Error(`${description} is not a Docker-safe label value`);
  }
  return value;
}

function bindMount(source, readOnly) {
  if (source.includes(",")) {
    throw new Error(`Docker bind-mount path contains a comma: ${source}`);
  }
  return `type=bind,src=${source},dst=${source}${readOnly ? ",readonly" : ""}`;
}

function readRuntimeMarker(stateDir) {
  const markerPath = join(stateDir, "workspace", imageConfig.markerFile);
  const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`invalid container marker at ${markerPath}`);
  }
  const runId = safeLabelValue(parsed.runId, "run id");
  const agentName = safeLabelValue(parsed.agentName, "agent name");
  if (typeof parsed.dockerBin !== "string" || parsed.dockerBin.length === 0) {
    throw new Error(`container marker has no Docker binary at ${markerPath}`);
  }
  return { agentName, dockerBin: parsed.dockerBin, runId };
}

function readConfiguredAgentName(stateDir) {
  const configPath = join(stateDir, "openclaw.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const agentName = parsed?.agents?.list?.[0]?.id;
  if (typeof agentName !== "string") {
    throw new Error(`OpenClaw config has no default agent at ${configPath}`);
  }
  return agentName;
}

/** Return the deterministic run-owned container name. */
export function openClawContainerName(runtime) {
  const run = runtime.runId.replaceAll(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 12);
  const agent = runtime.agentName
    .replaceAll(/[^A-Za-z0-9_.-]/gu, "-")
    .slice(0, 30);
  return `moltzap-sim-${run}-${agent}`;
}

/** Build the security, mount, identity, and command arguments for one agent. */
export function buildDockerRunArguments(input) {
  if (input.uid === 0 || input.gid === 0) {
    throw new Error(
      "the local container example must run as a non-root host user",
    );
  }
  const name = openClawContainerName(input.runtime);
  const environment = REQUIRED_RUNTIME_ENVIRONMENT.flatMap((key) => [
    "--env",
    `${key}=${requiredEnvironment(input.environment, key)}`,
  ]);
  const mounts = [
    "--mount",
    bindMount(input.stateDir, false),
    ...input.readOnlyMounts.flatMap((source) => [
      "--mount",
      bindMount(source, true),
    ]),
  ];
  return [
    "run",
    "--rm",
    "--pull=missing",
    "--name",
    name,
    "--label",
    `${LABEL_PREFIX}.example=original-openclaw`,
    "--label",
    `${LABEL_PREFIX}.run=${input.runtime.runId}`,
    "--label",
    `${LABEL_PREFIX}.agent=${input.runtime.agentName}`,
    "--network=host",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    "--stop-timeout=5",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--user",
    `${input.uid}:${input.gid}`,
    ...mounts,
    "--workdir",
    input.stateDir,
    ...environment,
    "--env",
    "OPENCLAW_DISABLE_BONJOUR=1",
    imageConfig.image,
    "node",
    OPENCLAW_ENTRYPOINT,
    ...input.openClawArguments,
  ];
}

function validateInvocation(openClawArguments) {
  if (openClawArguments[0] !== "gateway" || openClawArguments[1] !== "run") {
    throw new Error(
      "the local container launcher supports only workspace-mode OpenClaw gateways",
    );
  }
}

function commandFailure(result) {
  const error = result.error?.message;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return error ?? (stderr || `docker exited ${String(result.status)}`);
}

/** Force-remove one exact run container and confirm absence before returning. */
export function removeContainer(
  name,
  { dockerBin = "docker", execute = spawnSync } = {},
) {
  let detail = "container removal was not attempted";
  for (let attempt = 0; attempt < CONTAINER_REMOVE_ATTEMPTS; attempt += 1) {
    const removed = execute(dockerBin, ["rm", "--force", name], {
      encoding: "utf8",
      timeout: CONTAINER_STOP_TIMEOUT_MS,
    });
    if (removed.status === 0) {
      return { removed: true };
    }
    detail = commandFailure(removed);
    const inspected = execute(dockerBin, ["container", "inspect", name], {
      encoding: "utf8",
      timeout: CONTAINER_STOP_TIMEOUT_MS,
    });
    const inspectFailure = commandFailure(inspected);
    if (inspected.status !== 0 && MISSING_CONTAINER.test(inspectFailure)) {
      return { removed: true };
    }
    detail = `${detail}; confirmation failed: ${inspectFailure}`;
  }
  return { detail, removed: false };
}

function launch(openClawArguments) {
  validateInvocation(openClawArguments);
  const stateDir = requiredEnvironment(process.env, "OPENCLAW_STATE_DIR");
  const runtime = readRuntimeMarker(stateDir);
  const configuredAgentName = readConfiguredAgentName(stateDir);
  if (configuredAgentName !== runtime.agentName) {
    throw new Error(
      `container marker agent ${runtime.agentName} does not match OpenClaw agent ${configuredAgentName}`,
    );
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("the local container launcher requires a POSIX host");
  }
  const name = openClawContainerName(runtime);
  const dockerArguments = buildDockerRunArguments({
    environment: process.env,
    gid,
    openClawArguments,
    readOnlyMounts: READ_ONLY_MOUNTS,
    runtime,
    stateDir,
    uid,
  });
  const child = spawn(runtime.dockerBin, dockerArguments, { stdio: "inherit" });
  const removeOwnedContainer = () =>
    removeContainer(name, { dockerBin: runtime.dockerBin });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    const cleanup = removeOwnedContainer();
    if (!cleanup.removed) {
      console.error(`unable to remove ${name}: ${cleanup.detail}`);
      child.kill(signal);
    }
    process.exit(cleanup.removed ? (signal === "SIGINT" ? 130 : 143) : 1);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("error", (cause) => {
    const cleanup = removeOwnedContainer();
    if (!cleanup.removed) {
      console.error(`unable to remove ${name}: ${cleanup.detail}`);
    }
    console.error(`unable to start Docker: ${String(cause)}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (stopping) {
      return;
    }
    const cleanup = removeOwnedContainer();
    if (!cleanup.removed) {
      console.error(`unable to remove ${name}: ${cleanup.detail}`);
    }
    process.exitCode = cleanup.removed
      ? (code ?? (signal === null ? 1 : 128))
      : 1;
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  launch(process.argv.slice(2));
}
