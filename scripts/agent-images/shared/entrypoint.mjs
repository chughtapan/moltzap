#!/usr/bin/env node
/** PID 1 for an agent image containing an agent host and moltzapd. */

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
const SHUTDOWN_GRACE_MILLIS = 5_000;
const DAEMON_ENVIRONMENT_KEYS = Object.freeze([
  "MOLTZAPD_ADMISSION_CREDENTIAL_FILE",
  "MOLTZAPD_AGENT_PRIVATE_KEY_FILE",
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

async function chownTree(path, uid, gid) {
  const info = await lstat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      await chownTree(join(path, entry), uid, gid);
    }
  }
  await lchown(path, uid, gid);
}

async function prepareFilesystem(options) {
  await mkdir(options.stateDirectory, { recursive: true });
  await chownTree(
    options.stateDirectory,
    options.daemonUserId,
    options.daemonGroupId,
  );
  await chmod(options.stateDirectory, 0o700);
  await mkdir(options.secretDirectory, { recursive: true, mode: 0o700 });
  await chown(
    options.secretDirectory,
    options.daemonUserId,
    options.daemonGroupId,
  );
  await chmod(options.secretDirectory, 0o700);
  for (const source of await readdir(options.secretSource)) {
    const sourcePath = join(options.secretSource, source);
    if (!(await lstat(sourcePath)).isFile()) continue;
    const destination = join(options.secretDirectory, basename(source));
    await copyFile(sourcePath, destination);
    await chown(destination, options.daemonUserId, options.daemonGroupId);
    await chmod(destination, 0o400);
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

async function terminate(child, signal = "SIGTERM") {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const stopped = waitForExit(child, "terminating child");
  child.kill(signal);
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, SHUTDOWN_GRACE_MILLIS);
  timer.unref();
  await stopped.catch(() => undefined);
  clearTimeout(timer);
}

function spawnChild(command, options) {
  const [executable, ...args] = command;
  return spawn(executable, args, {
    env: options.environment,
    gid: options.groupId,
    stdio: "inherit",
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
    hostUserId,
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
  const options = runtimeOptions(environment);
  await prepareFilesystem(options);
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
  const forwardSignal = (signal) => {
    requestedSignal = signal;
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
    if (requestedSignal !== undefined) {
      await terminate(daemon, requestedSignal);
      return 0;
    }
    host = spawnChild(hostCommand, {
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
    const stopped = await Promise.race([
      waitForExit(daemon, "moltzapd"),
      waitForExit(host, "agent host"),
    ]);
    await terminate(stopped.label === "moltzapd" ? host : daemon);
    return stopped.code;
  } finally {
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
