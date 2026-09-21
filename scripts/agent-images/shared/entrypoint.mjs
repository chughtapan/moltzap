#!/usr/bin/env node
/** PID 1 for an agent image containing an agent host and moltzapd. */

import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  copyFile,
  lchown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST_COMMAND_PATH = "/opt/moltzap/agent/host-command.json";
const DEFAULT_DAEMON_EXECUTABLE =
  "/opt/moltzap/node_modules/@moltzap/client/bin/moltzapd";
const DEFAULT_REGISTRAR = "/opt/moltzap/agent/register-daemon.mjs";
const DEFAULT_SECRET_SOURCE = "/var/run/moltzap/daemon-source";
const DEFAULT_SECRET_DIRECTORY = "/var/run/moltzap/daemon";
const DEFAULT_STATE_DIRECTORY = "/var/lib/moltzap/endpoint";
const DEFAULT_HOST_USER_ID = 1_000;
const DEFAULT_DAEMON_USER_ID = 1_001;
const DEFAULT_HOST_FINALIZER = "/opt/moltzap/agent/finalize-host.mjs";
const DEFAULT_HOST_FINALIZER_TIMEOUT_MILLIS = 20_000;
/**
 * The tag a host finalizer's summary must carry, so it must stay equal to
 * `SCHEMA` in the image's finalizer, such as `openclaw/finalize-host.mjs`.
 * Importing it from one image's script would tie every image to that image.
 */
const MODEL_USAGE_SCHEMA = "moltzap.agent-model-usage/v1";
/** The simulator reads this file with a 1 MiB bound. */
const MAXIMUM_MODEL_USAGE_BYTES = 1_024 * 1_024;
const SHUTDOWN_GRACE_MILLIS = 5_000;
/** @type {WeakMap<import("node:child_process").ChildProcess, Promise<void>>} */
const terminations = new WeakMap();
const DAEMON_ENVIRONMENT_KEYS = Object.freeze([
  "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
  "MOLTZAPD_AGENT_PRIVATE_KEY_FILE",
  "MOLTZAPD_HISTORY_EXPORT",
  "MOLTZAPD_MCP_PORT",
  "MOLTZAPD_REGISTRY_ORIGIN",
  "MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY",
  "MOLTZAPD_ROUTER_ORIGIN",
  "MOLTZAPD_STATE_DIRECTORY",
]);
const REGISTRATION_ENVIRONMENT_KEYS = Object.freeze([
  "MOLTZAP_MCP_URL",
  "MOLTZAP_REGISTRATION_AGENT_NAME",
  "MOLTZAP_REGISTRATION_OPERATION_ID",
  "MOLTZAP_REGISTRATION_PRINCIPAL_ID",
]);
const BASE_ENVIRONMENT_KEYS = Object.freeze([
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TZ",
]);

function numericEnvironment(environment, name, fallback) {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + " must be a non-negative integer");
  }
  return value;
}

function selectedEnvironment(environment, keys) {
  return Object.fromEntries(
    keys.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function baseEnvironment(environment) {
  return {
    ...selectedEnvironment(environment, BASE_ENVIRONMENT_KEYS),
    NODE_ENV: environment.NODE_ENV ?? "production",
  };
}

function hostEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        !name.startsWith("MOLTZAPD_") &&
        !name.startsWith("MOLTZAP_REGISTRATION_") &&
        !name.startsWith("MOLTZAP_AGENT_IMAGE_"),
    ),
  );
}

/**
 * Run the image's host finalizer and keep what it prints.
 *
 * The finalizer reads files the agent's model could have written, so it runs
 * as the host user and only prints; this process, PID 1, stays out of those
 * files and owns the output path, which the host cannot reach. A finalizer
 * that fails, overruns or prints something else still yields a file, so a
 * reader can tell a failed summary from an image that was never asked for one.
 *
 * @param {ReturnType<typeof runtimeOptions>} options Entrypoint options.
 * @param {NodeJS.ProcessEnv} environment The container environment.
 * @returns {Promise<{status: string, reason?: string, body?: string}>}
 */
async function collectModelUsage(options, environment) {
  try {
    await stat(options.hostFinalizer);
  } catch {
    return {
      status: "finalizer-failed",
      reason: "the image ships no host finalizer",
    };
  }
  const child = spawn(process.execPath, [options.hostFinalizer], {
    env: hostEnvironment(environment),
    gid: options.hostGroupId,
    uid: options.hostUserId,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks = [];
  let bytes = 0;
  let overrun = false;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAXIMUM_MODEL_USAGE_BYTES) {
      overrun = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.hostFinalizerTimeoutMillis);
  const code = await new Promise((resolveExit) => {
    child.once("error", () => resolveExit(1));
    child.once("close", (exitCode) => resolveExit(exitCode ?? 1));
  });
  clearTimeout(timer);
  if (timedOut) return { status: "finalizer-timeout" };
  if (overrun) {
    return { status: "finalizer-failed", reason: "the summary exceeds 1 MiB" };
  }
  if (code !== 0) {
    return { status: "finalizer-failed", reason: "exit code " + String(code) };
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    if (JSON.parse(body)?.schema !== MODEL_USAGE_SCHEMA) {
      return { status: "finalizer-failed", reason: "unexpected schema" };
    }
  } catch {
    return { status: "finalizer-failed", reason: "the summary is not JSON" };
  }
  return { status: "ok", body };
}

/**
 * @param {ReturnType<typeof runtimeOptions>} options Entrypoint options.
 * @param {NodeJS.ProcessEnv} environment The container environment.
 * @returns {Promise<void>}
 */
async function writeModelUsage(options, environment) {
  const collected = await collectModelUsage(options, environment);
  const body =
    collected.body ??
    JSON.stringify({
      schema: MODEL_USAGE_SCHEMA,
      status: collected.status,
      ...(collected.reason === undefined ? {} : { reason: collected.reason }),
      writtenAt: new Date().toISOString(),
      agents: [],
    });
  const staged = options.modelUsage + ".partial";
  await writeFile(staged, body, { mode: 0o600 });
  await rename(staged, options.modelUsage);
}

async function chownTree(path, uid, gid) {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await chownTree(join(path, entry), uid, gid);
    }
  }
  await lchown(path, uid, gid);
}

async function prepareOwnedDirectory(path, uid, gid) {
  await mkdir(path, { recursive: true });
  await chownTree(path, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
  await chmod(path, 0o700);
  await chownTree(path, uid, gid);
}

/**
 * The export lives outside every directory the daemon owns, so PID 1 creates
 * the empty file and hands it over; the daemon only ever appends to it.
 *
 * @param {string} path Absolute path of the file to create.
 * @param {number} uid Owner the daemon runs as.
 * @param {number} gid Group the daemon runs as.
 * @returns {Promise<void>}
 */
async function prepareOwnedFile(path, uid, gid) {
  await writeFile(path, "", { flag: "a", mode: 0o600 });
  await chown(path, uid, gid);
}

async function prepareFilesystem(options) {
  await prepareOwnedDirectory(
    options.stateDirectory,
    options.daemonUserId,
    options.daemonGroupId,
  );
  if (options.historyExport !== undefined) {
    await prepareOwnedFile(
      options.historyExport,
      options.daemonUserId,
      options.daemonGroupId,
    );
  }
  await prepareOwnedDirectory(
    options.secretDirectory,
    options.daemonUserId,
    options.daemonGroupId,
  );
  for (const source of await readdir(options.secretSource)) {
    const sourcePath = join(options.secretSource, source);
    if (!(await stat(sourcePath)).isFile()) continue;
    const destination = join(options.secretDirectory, basename(source));
    await copyFile(sourcePath, destination);
    await chmod(destination, 0o400);
    await chown(destination, options.daemonUserId, options.daemonGroupId);
  }
}

async function readHostCommand(path) {
  const decoded = JSON.parse(await readFile(path, "utf8"));
  if (
    !Array.isArray(decoded) ||
    decoded.length === 0 ||
    decoded.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error("agent host command must be a non-empty string array");
  }
  return decoded;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      label,
      code:
        child.exitCode ??
        (child.signalCode === "SIGTERM" || child.signalCode === "SIGINT"
          ? 0
          : 1),
      signal: child.signalCode,
    });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit({
        label,
        code: code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1),
        signal,
      });
    });
  });
}

/**
 * Stop the owned process group even when its leader exits before descendants.
 * @param {import("node:child_process").ChildProcess | undefined} child Group leader.
 * @param {NodeJS.Signals} signal Initial shutdown signal.
 * @returns {Promise<void>} Resolves after exit or group-wide forced termination.
 */
function terminate(child, signal = "SIGTERM") {
  if (child === undefined) return Promise.resolve();
  let pending = terminations.get(child);
  if (pending === undefined) {
    pending = stopProcessGroup(child, signal);
    terminations.set(child, pending);
  }
  return pending;
}

/**
 * Poll group lifetime independently of the leader's exit notification.
 * @param {import("node:child_process").ChildProcess} child Group leader.
 * @param {NodeJS.Signals} signal Initial shutdown signal.
 * @returns {Promise<void>} Resolves after the owned group has stopped or received SIGKILL.
 */
async function stopProcessGroup(child, signal) {
  if (child?.pid === undefined) {
    return;
  }
  const stopped = waitForExit(child, "terminating child");
  signalGroup(child.pid, signal);
  const deadline = Date.now() + SHUTDOWN_GRACE_MILLIS;
  while (signalGroup(child.pid, 0)) {
    if (Date.now() >= deadline) {
      signalGroup(child.pid, "SIGKILL");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopped.catch(() => undefined);
}

/**
 * ESRCH means this owned process group has already disappeared.
 * @param {number} leader Group leader PID returned by spawn.
 * @param {NodeJS.Signals | 0} signal Signal or existence probe.
 * @returns {boolean} Whether the process group still exists.
 */
function signalGroup(leader, signal) {
  try {
    process.kill(-leader, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

/**
 * A stuck output drain must never publish a successful flush acknowledgement.
 * @param {Promise<void>[]} drains Native log writable completion promises.
 * @returns {Promise<void>} Resolves only when every native log has drained.
 */
async function drainLogs(drains) {
  let timer;
  try {
    await Promise.race([
      Promise.all(drains),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("runtime log drain timed out")),
          SHUTDOWN_GRACE_MILLIS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnChild(command, options) {
  const [executable, ...args] = command;
  return spawn(executable, args, {
    detached: true,
    env: options.environment,
    gid: options.groupId,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    uid: options.userId,
  });
}

function daemonEnvironment(environment, options) {
  return {
    ...baseEnvironment(environment),
    HOME: options.stateDirectory,
    ...selectedEnvironment(environment, DAEMON_ENVIRONMENT_KEYS),
    MOLTZAPD_STATE_DIRECTORY: options.stateDirectory,
  };
}

function registrarEnvironment(environment) {
  return {
    ...baseEnvironment(environment),
    HOME: "/tmp",
    ...selectedEnvironment(environment, REGISTRATION_ENVIRONMENT_KEYS),
  };
}

function runtimeOptions(environment) {
  const daemonUserId = numericEnvironment(
    environment,
    "MOLTZAP_AGENT_IMAGE_DAEMON_UID",
    DEFAULT_DAEMON_USER_ID,
  );
  const hostUserId = numericEnvironment(
    environment,
    "MOLTZAP_AGENT_IMAGE_HOST_UID",
    DEFAULT_HOST_USER_ID,
  );
  return {
    logDirectory:
      environment.MOLTZAP_AGENT_IMAGE_LOG_DIRECTORY ?? "/var/run/moltzap",
    daemonExecutable:
      environment.MOLTZAP_AGENT_IMAGE_DAEMON_EXECUTABLE ??
      DEFAULT_DAEMON_EXECUTABLE,
    daemonGroupId: numericEnvironment(
      environment,
      "MOLTZAP_AGENT_IMAGE_DAEMON_GID",
      daemonUserId,
    ),
    daemonUserId,
    hostCommandPath:
      environment.MOLTZAP_AGENT_IMAGE_HOST_COMMAND ?? DEFAULT_HOST_COMMAND_PATH,
    hostGroupId: numericEnvironment(
      environment,
      "MOLTZAP_AGENT_IMAGE_HOST_GID",
      hostUserId,
    ),
    hostFinalizer:
      environment.MOLTZAP_AGENT_IMAGE_HOST_FINALIZER ?? DEFAULT_HOST_FINALIZER,
    hostFinalizerTimeoutMillis: numericEnvironment(
      environment,
      "MOLTZAP_AGENT_IMAGE_HOST_FINALIZER_TIMEOUT_MS",
      DEFAULT_HOST_FINALIZER_TIMEOUT_MILLIS,
    ),
    hostUserId,
    historyExport: environment.MOLTZAPD_HISTORY_EXPORT,
    modelUsage: environment.MOLTZAP_AGENT_IMAGE_MODEL_USAGE,
    registrar: environment.MOLTZAP_AGENT_IMAGE_REGISTRAR ?? DEFAULT_REGISTRAR,
    secretDirectory:
      environment.MOLTZAP_AGENT_IMAGE_SECRET_DIRECTORY ??
      DEFAULT_SECRET_DIRECTORY,
    secretSource:
      environment.MOLTZAP_AGENT_IMAGE_SECRET_SOURCE ?? DEFAULT_SECRET_SOURCE,
    stateDirectory:
      environment.MOLTZAPD_STATE_DIRECTORY ?? DEFAULT_STATE_DIRECTORY,
  };
}

/** Run one agent host and one daemon as a single fail-fast application. */
export async function runAgentImage(environment = process.env) {
  const previousReportOnSignal = process.report.reportOnSignal;
  process.report.reportOnSignal = false;
  const options = runtimeOptions(environment);
  await prepareFilesystem(options);
  await mkdir(options.logDirectory, { recursive: true, mode: 0o700 });
  const hostCommand = await readHostCommand(options.hostCommandPath);
  const daemon = spawnChild([options.daemonExecutable], {
    environment: daemonEnvironment(environment, options),
    groupId: options.daemonGroupId,
    userId: options.daemonUserId,
  });
  const registrar = spawnChild([process.execPath, options.registrar], {
    environment: registrarEnvironment(environment),
    groupId: options.hostGroupId,
    userId: options.hostUserId,
  });
  let host;
  let requestedSignal;
  let observeShutdown;
  const shutdown = new Promise((resolve) => {
    observeShutdown = resolve;
  });
  let finalization;
  let logDrains = [];
  /** Failed flushes keep their files harvestable without a successful acknowledgement. */
  const finalize = () => {
    if (finalization !== undefined) return;
    finalization = (async () => {
      const requestedAt = new Date().toISOString();
      const started = process.hrtime.bigint();
      await terminate(host);
      const hostStoppedAt = new Date().toISOString();
      if (options.modelUsage !== undefined) {
        await writeModelUsage(options, environment).catch((cause) => {
          process.stderr.write(
            "model usage was not written: " +
              (cause instanceof Error ? cause.message : "unknown failure") +
              "\n",
          );
        });
      }
      await terminate(daemon);
      await drainLogs(logDrains);
      await writeFile(
        join(options.logDirectory, "finalized.json"),
        JSON.stringify({
          requestedAt,
          hostStoppedAt,
          flushedAt: new Date().toISOString(),
          durationNanos: String(process.hrtime.bigint() - started),
        }),
        { mode: 0o600 },
      );
    })().catch((cause) => {
      const message =
        cause instanceof Error ? cause.message : "unknown failure";
      process.stderr.write("runtime finalization failed: " + message + "\n");
    });
  };
  process.on("SIGUSR2", finalize);
  const forwardSignal = (signal) => {
    requestedSignal = signal;
    observeShutdown();
    void terminate(registrar, signal);
    void terminate(host, signal);
    void terminate(daemon, signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    const bootstrap = await Promise.race([
      waitForExit(daemon, "moltzapd"),
      waitForExit(registrar, "registration"),
    ]);
    if (requestedSignal !== undefined) {
      return 0;
    }
    if (bootstrap.label === "moltzapd") {
      await terminate(registrar);
      throw new Error(
        "moltzapd exited during registration (" + String(bootstrap.code) + ")",
      );
    }
    if (bootstrap.code !== 0) {
      await terminate(daemon);
      throw new Error(
        "daemon registration failed (" + String(bootstrap.code) + ")",
      );
    }
    host = spawnChild(hostCommand, {
      capture: true,
      environment: {
        ...hostEnvironment(environment),
        HOME:
          environment.MOLTZAP_AGENT_IMAGE_HOST_HOME ??
          environment.HOME ??
          "/home/node",
      },
      groupId: options.hostGroupId,
      userId: options.hostUserId,
    });
    const stdoutLog = createWriteStream(
      join(options.logDirectory, "runtime.stdout.log"),
      { mode: 0o600 },
    );
    const stderrLog = createWriteStream(
      join(options.logDirectory, "runtime.stderr.log"),
      { mode: 0o600 },
    );
    host.stdout.pipe(stdoutLog);
    host.stdout.pipe(process.stdout, { end: false });
    host.stderr.pipe(stderrLog);
    host.stderr.pipe(process.stderr, { end: false });
    logDrains = [finished(stdoutLog), finished(stderrLog)];
    for (const drain of logDrains) drain.catch(() => terminate(host));
    const stopped = await Promise.race([
      waitForExit(daemon, "moltzapd"),
      waitForExit(host, "agent host"),
    ]);
    if (finalization !== undefined) {
      await finalization;
      /** Pending Promises and signal listeners do not keep a standalone Node process alive. */
      const keepAlive = setInterval(() => undefined, 60_000);
      try {
        await shutdown;
      } finally {
        clearInterval(keepAlive);
      }
      return 0;
    }
    await terminate(stopped.label === "moltzapd" ? host : daemon);
    return stopped.code;
  } finally {
    process.report.reportOnSignal = previousReportOnSignal;
    process.removeListener("SIGUSR2", finalize);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await Promise.all([
      terminate(registrar),
      terminate(host),
      terminate(daemon),
    ]);
  }
}

async function main() {
  process.exitCode = await runAgentImage();
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((cause) => {
    const message = cause instanceof Error ? cause.message : "unknown failure";
    process.stderr.write("agent image failed: " + message + "\n");
    process.exitCode = 1;
  });
}
