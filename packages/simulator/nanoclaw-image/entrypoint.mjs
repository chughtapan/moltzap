// The MoltZap application entrypoint of the NanoClaw image: the process the
// simulator's container runtime starts, and the only thing in the image that
// knows the bootstrap contract in `src/agents/nanoclaw/runtime.ts`.
//
// It reads the `moltzap.nanoclaw-application/v1` bootstrap config, materializes
// a writable NanoClaw project root, seeds the eval agent group, starts NanoClaw,
// and republishes NanoClaw's owner-local CLI socket on the fixed bridge port.
//
// The project root has to be writable and has to be NanoClaw's cwd: NanoClaw
// resolves `data/`, `groups/`, `store/`, and its own `package.json` from
// `process.cwd()`. The installed tree under /opt is immutable and shared, so
// this materializes a per-run root that links the immutable halves and owns the
// mutable ones.
//
// The bridge is a byte relay, not a protocol: NanoClaw's CLI channel already
// speaks the NDJSON `{ "text": ... }` frames the controller's gateway decodes,
// so the TCP realization differs from the Unix-socket one only in transport.
// It starts listening only once the socket exists, because an open port is what
// the controller reads as readiness and a port opened early would silently
// discard the run's first instruction.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { cp, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APPLICATION_ROOT = "/opt/moltzap/nanoclaw/app";
const BOOTSTRAP_API_VERSION = "moltzap.nanoclaw-application/v1";
const EVAL_AGENT_GROUP_ID = "eval-agent";
const CLI_SOCKET_POLL_MS = 100;
const CLI_SOCKET_TIMEOUT_MS = 120_000;
const PROVISION_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 15_000;
// NanoClaw resolves these from its cwd and writes into all of them. `data`
// is absent because the copied install already carries it, stamped marker
// included.
const MUTABLE_DIRECTORIES = ["groups", "store", "tmp"];
// Read-only halves of the install. `container` is copied rather than linked
// because the run's own workspace files are seeded into `container/skills`.
const LINKED_ENTRIES = ["dist", "node_modules", "src", "scripts", "templates"];
const COPIED_ENTRIES = ["container", "package.json", "data"];

function fail(detail) {
  throw new Error(`NanoClaw application bootstrap failed: ${detail}`);
}

function requiredEnvironment(key) {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    fail(`${key} is required`);
  }
  return value;
}

async function readBootstrapConfig() {
  const path = requiredEnvironment("MOLTZAP_NANOCLAW_CONFIG");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config.apiVersion !== BOOTSTRAP_API_VERSION) {
    fail(`${path} is not ${BOOTSTRAP_API_VERSION}`);
  }
  if (typeof config.agentName !== "string" || config.agentName.length === 0) {
    fail(`${path} carries no agent name`);
  }
  return config;
}

async function materializeProjectRoot(config) {
  const projectRoot =
    config.stateDirectory ?? requiredEnvironment("MOLTZAP_NANOCLAW_STATE");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    ...LINKED_ENTRIES.map((entry) =>
      symlink(join(APPLICATION_ROOT, entry), join(projectRoot, entry)),
    ),
    ...COPIED_ENTRIES.map((entry) =>
      cp(join(APPLICATION_ROOT, entry), join(projectRoot, entry), {
        recursive: true,
      }),
    ),
    ...MUTABLE_DIRECTORIES.map((directory) =>
      mkdir(join(projectRoot, directory), { recursive: true }),
    ),
  ]);
  return projectRoot;
}

// The run's workspace files are NanoClaw skills, and NanoClaw mounts
// `container/skills` into every agent turn.
async function seedWorkspace(config, projectRoot) {
  const source = config.workspaceDirectory;
  if (typeof source !== "string" || source.length === 0) {
    return;
  }
  const exists = await stat(source).then(
    () => true,
    () => false,
  );
  if (exists) {
    await cp(source, join(projectRoot, "container", "skills"), {
      recursive: true,
    });
  }
}

// Rekeyed by name and otherwise forwarded verbatim, because the definition is
// the runtime's, not this file's: a server may be spawned over stdio or reached
// over streamable HTTP, and rebuilding either shape here would silently drop
// whichever field this file was not written for. The pinned NanoClaw revision
// honours the stdio shape only; a URL server rides through untouched so a
// revision bump starts honouring it without another change here.
function mcpServerConfiguration(servers) {
  return Object.fromEntries(
    servers.map(({ name, ...definition }) => [name, definition]),
  );
}

function childEnvironment(config, projectRoot) {
  const mcpServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
  return {
    ...process.env,
    MOLTZAP_EVAL_MODE: config.autoRegisterConversations === true ? "1" : "0",
    TMPDIR: join(projectRoot, "tmp"),
    ...(typeof config.modelId === "string" && config.modelId.length > 0
      ? { MOLTZAP_AGENT_MODEL: config.modelId }
      : {}),
    ...(mcpServers.length === 0
      ? {}
      : {
          MOLTZAP_MCP_SERVERS: JSON.stringify(
            mcpServerConfiguration(mcpServers),
          ),
        }),
  };
}

// The runtime database starts empty and NanoClaw's router drops an unwired
// conversation, so the eval agent group and its CLI wiring exist before the
// first inbound delivery rather than after it.
async function provisionEvalAgent(config, projectRoot, environment) {
  const child = spawn(
    "node",
    [
      join(APPLICATION_ROOT, "dist", "moltzap-eval-provision.js"),
      EVAL_AGENT_GROUP_ID,
      config.agentName,
      EVAL_AGENT_GROUP_ID,
    ],
    {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
      timeout: PROVISION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    fail(
      `eval provisioning exited with code=${String(code)} signal=${String(signal)}`,
    );
  }
}

async function waitForCliSocket(socketPath, stopped) {
  const deadline = Date.now() + CLI_SOCKET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stopped.exited) {
      fail(`NanoClaw exited before its CLI socket appeared: ${stopped.detail}`);
    }
    const ready = await stat(socketPath).then(
      () => true,
      () => false,
    );
    if (ready) {
      return;
    }
    await delay(CLI_SOCKET_POLL_MS);
  }
  fail(
    `NanoClaw did not open ${socketPath} within ${String(CLI_SOCKET_TIMEOUT_MS)}ms`,
  );
}

function relay(socketPath, inbound) {
  const upstream = connect(socketPath);
  const close = () => {
    inbound.destroy();
    upstream.destroy();
  };
  inbound.on("error", close);
  upstream.on("error", close);
  inbound.pipe(upstream);
  upstream.pipe(inbound);
}

function listenBridge(config, socketPath) {
  const gateway = config.gateway ?? {};
  const port = gateway.port;
  if (typeof port !== "number") {
    fail("the bootstrap config carries no gateway port");
  }
  return new Promise((resolve, reject) => {
    const server = createServer((inbound) => {
      relay(socketPath, inbound);
    });
    server.once("error", reject);
    server.listen(port, gateway.host ?? "0.0.0.0", () => {
      resolve(server);
    });
  });
}

function forwardShutdown(child) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      child.kill(signal);
      setTimeout(() => {
        child.kill("SIGKILL");
      }, SHUTDOWN_GRACE_MS).unref();
    });
  }
}

function startNanoClaw(projectRoot, environment) {
  const child = spawn("node", [join(APPLICATION_ROOT, "dist", "index.js")], {
    cwd: projectRoot,
    env: environment,
    stdio: "inherit",
  });
  const stopped = { exited: false, detail: "" };
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      stopped.exited = true;
      stopped.detail = `code=${String(code)} signal=${String(signal)}`;
      resolve(code ?? 1);
    });
    child.once("error", (cause) => {
      stopped.exited = true;
      stopped.detail = String(cause);
      resolve(1);
    });
  });
  forwardShutdown(child);
  return { exit, stopped };
}

const config = await readBootstrapConfig();
const projectRoot = await materializeProjectRoot(config);
await seedWorkspace(config, projectRoot);
const environment = childEnvironment(config, projectRoot);
await provisionEvalAgent(config, projectRoot, environment);
const nanoclaw = startNanoClaw(projectRoot, environment);
const socketPath = join(projectRoot, "data", "cli.sock");
await waitForCliSocket(socketPath, nanoclaw.stopped);
const bridge = await listenBridge(config, socketPath);
const exitCode = await nanoclaw.exit;
bridge.close();
process.exit(exitCode);
