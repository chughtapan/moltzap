/** @file Starts the native NanoClaw host inside the complete agent image. */
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import net from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { provisionNanoClaw } from "./provision.mjs";

const APP_ROOT = "/opt/moltzap/nanoclaw/app";
const PRELOAD = "/opt/moltzap/nanoclaw/preload.mjs";
const DEFAULT_CONFIG = "/var/run/moltzap/bootstrap/nanoclaw/runtime.json";
const DEFAULT_STATE = "/var/lib/moltzap/nanoclaw";
const STARTUP_TIMEOUT_MILLIS = 120_000;

function delay(millis) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, millis));
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureLink(target, source) {
  const info = await pathInfo(target);
  if (info?.isSymbolicLink()) {
    const linked = resolve(dirname(target), await readlink(target));
    if (linked === resolve(source)) return;
    await unlink(target);
  } else if (info !== undefined) {
    throw new Error(
      `NanoClaw state surface already exists and is not a link: ${target}`,
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target);
}

function decodeConfig(value) {
  if (
    value?.apiVersion !== "moltzap.nanoclaw-application/v1" ||
    typeof value.agentName !== "string" ||
    value.agentName.length === 0 ||
    typeof value.stateDirectory !== "string" ||
    !isAbsolute(value.stateDirectory) ||
    typeof value.workspaceDirectory !== "string" ||
    !isAbsolute(value.workspaceDirectory) ||
    typeof value.gateway?.host !== "string" ||
    !Number.isInteger(value.gateway?.port) ||
    value.gateway.port < 1 ||
    value.gateway.port > 65_535 ||
    !Array.isArray(value.mcpServers)
  ) {
    throw new Error("invalid MoltZap NanoClaw application configuration");
  }
  return value;
}

async function materializeProject(config) {
  await mkdir(config.stateDirectory, { recursive: true });
  for (const directory of ["data", "groups", "store", "tmp"]) {
    await mkdir(`${config.stateDirectory}/${directory}`, { recursive: true });
  }
  for (const surface of ["container", "scripts", "templates", "package.json"]) {
    await ensureLink(
      `${config.stateDirectory}/${surface}`,
      `${APP_ROOT}/${surface}`,
    );
  }
}

async function waitForSocket(socketPath, host) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MILLIS;
  while (Date.now() < deadline) {
    if (host.exitCode !== null || host.signalCode !== null) {
      throw new Error(
        `NanoClaw host exited before its CLI socket was ready (${String(host.exitCode ?? host.signalCode)})`,
      );
    }
    const info = await pathInfo(socketPath);
    if (info?.isSocket()) return;
    await delay(50);
  }
  throw new Error(
    `NanoClaw CLI socket was not ready within ${String(STARTUP_TIMEOUT_MILLIS)}ms`,
  );
}

function startGateway(config, socketPath) {
  const server = net.createServer((client) => {
    const native = net.createConnection(socketPath);
    client.pipe(native);
    native.pipe(client);
    const close = () => {
      client.destroy();
      native.destroy();
    };
    client.on("error", close);
    native.on("error", close);
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(config.gateway.port, config.gateway.host, () =>
      resolveServer(server),
    );
  });
}

async function main() {
  const configPath = process.env.MOLTZAP_NANOCLAW_CONFIG ?? DEFAULT_CONFIG;
  const config = decodeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const configuredState = process.env.MOLTZAP_NANOCLAW_STATE ?? DEFAULT_STATE;
  if (resolve(config.stateDirectory) !== resolve(configuredState)) {
    throw new Error(
      "NanoClaw state directory disagrees with the application environment",
    );
  }
  await materializeProject(config);
  process.chdir(config.stateDirectory);
  await provisionNanoClaw(config, { appRoot: APP_ROOT });

  const environment = {
    ...process.env,
    ASSISTANT_NAME: config.agentName,
    CONTAINER_IMAGE: "moltzap-nanoclaw-agent:embedded",
    DEFAULT_AGENT_PROVIDER: "claude",
    MOLTZAP_NANOCLAW_AGENT_GROUP_ID: "agent",
    NANOCLAW_GATEWAY_PROVIDER: "moltzap-process",
    NANOCLAW_RUNTIME_DRIVER: "moltzap-process",
    NANOCLAW_TEMPLATES_DIR: `${config.stateDirectory}/templates`,
    NODE_ENV: "production",
    TMPDIR: `${config.stateDirectory}/tmp`,
  };
  const host = spawn(
    process.execPath,
    ["--import", PRELOAD, `${APP_ROOT}/dist/index.js`],
    {
      cwd: config.stateDirectory,
      env: environment,
      stdio: "inherit",
    },
  );

  let gateway;
  const stop = (signal) => {
    gateway?.close();
    if (host.exitCode === null) host.kill(signal);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  const socketPath = `${config.stateDirectory}/data/cli.sock`;
  await waitForSocket(socketPath, host);
  gateway = await startGateway(config, socketPath);
  const exitCode = await new Promise((resolveExit, reject) => {
    host.once("error", reject);
    host.once("exit", (code, signal) => {
      gateway.close();
      resolveExit(
        code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1),
      );
    });
  });
  process.exitCode = exitCode;
}

await main();
