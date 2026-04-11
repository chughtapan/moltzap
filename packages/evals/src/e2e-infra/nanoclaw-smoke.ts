/**
 * Nanoclaw smoke test harness.
 *
 * Throwaway infrastructure to prove moltzap can talk to a real nanoclaw process
 * via the channel file in packages/nanoclaw-channel/. Not a production runtime
 * adapter. When the stable interface lands, this file is rewritten or deleted.
 *
 * Pinned to a specific nanoclaw upstream SHA. Bumping the SHA means:
 *   1. Delete ~/.cache/moltzap-evals/nanoclaw/<old-sha> manually
 *   2. Update NANOCLAW_SHA below
 *   3. Re-run the smoke eval; fix any type drift in packages/nanoclaw-channel/src/types.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { exec as execCb } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { logger } from "./logger.js";

const exec = promisify(execCb);

// OneCLI gateway — nanoclaw's container-runner calls this for per-container
// credential injection. Running locally from ~/.onecli/docker-compose.yml,
// dashboard on 10254, gateway on 10255. Install: curl -fsSL https://onecli.sh/install | sh
const ONECLI_URL = "http://127.0.0.1:10254";
const ONECLI_COMPOSE_PATH = path.join(
  os.homedir(),
  ".onecli/docker-compose.yml",
);

// Pinned to qwibitai/nanoclaw@934f063 (2026-04-10). Bump deliberately.
const NANOCLAW_SHA = "934f063aff5c30e7b49ce58b53b41901d3472a3e";
const NANOCLAW_URL = `https://github.com/qwibitai/nanoclaw/archive/${NANOCLAW_SHA}.tar.gz`;

const NANOCLAW_CACHE = path.join(
  os.homedir(),
  ".cache/moltzap-evals/nanoclaw",
  NANOCLAW_SHA.slice(0, 12),
);

// Log marker: the moltzap channel in packages/nanoclaw-channel/src/moltzap.ts
// emits "MoltZap connected" via the logger on successful connect. Anchoring
// against an "info" prefix reduces false positives from quoted error text.
const CONNECTED_MARKER = /\[info\].*MoltZap connected|MoltZap connected/;

const CONNECT_TIMEOUT_MS = 60_000;
const GRACEFUL_STOP_MS = 3_000;

export interface NanoclawSmokeHandle {
  proc: ChildProcess;
  dataDir: string;
  capturedLogs: string[];
}

async function isOnecliReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ONECLI_URL}/api/container-config`, {
      signal: AbortSignal.timeout(2_000),
    });
    // Any HTTP response means the dashboard is listening. A 401/403 is fine —
    // nanoclaw's SDK handles auth. We only care that the port is open.
    return res.status > 0;
  } catch {
    return false;
  }
}

async function ensureOnecliRunning(): Promise<void> {
  if (await isOnecliReachable()) {
    logger.info(`OneCLI gateway already running at ${ONECLI_URL}`);
    return;
  }

  if (!fs.existsSync(ONECLI_COMPOSE_PATH)) {
    throw new Error(
      `OneCLI gateway not running and not installed at ${ONECLI_COMPOSE_PATH}. ` +
        `Nanoclaw requires OneCLI to inject credentials into agent subcontainers. ` +
        `Install once with:\n\n  curl -fsSL https://onecli.sh/install | sh\n\n` +
        `Then open http://127.0.0.1:10254 and add your Anthropic credentials.`,
    );
  }

  logger.info("Starting OneCLI gateway (docker compose up)...");
  await exec(
    `docker compose -p onecli -f "${ONECLI_COMPOSE_PATH}" up -d --wait`,
    { timeout: 120_000 },
  );

  // `--wait` returns when healthchecks pass, but give the HTTP listener a
  // moment to bind before the first real request.
  for (let i = 0; i < 20; i++) {
    if (await isOnecliReachable()) {
      logger.info(`OneCLI gateway ready at ${ONECLI_URL}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `OneCLI gateway started but not reachable at ${ONECLI_URL} after 10s. ` +
      `Check: docker compose -p onecli -f ${ONECLI_COMPOSE_PATH} logs`,
  );
}

async function preflightDocker(): Promise<void> {
  try {
    await exec("docker info", { timeout: 5_000 });
  } catch (err) {
    throw new Error(
      "Nanoclaw smoke requires docker to be running on the host " +
        "(nanoclaw spawns agent subcontainers via its container-runner). " +
        `docker info failed: ${(err as Error).message}`,
    );
  }
}

async function downloadTarball(url: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const tarballPath = path.join(destDir, "nanoclaw.tar.gz");

  // Use curl for streaming + redirect handling. The eval host has curl.
  await exec(`curl -fsSL "${url}" -o "${tarballPath}"`, { timeout: 60_000 });

  // Extract with --strip-components=1 so the archive's top-level
  // nanoclaw-<sha>/ directory collapses into destDir itself.
  await exec(`tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1`, {
    timeout: 30_000,
  });

  await fsp.unlink(tarballPath);
}

function resolveChannelFilePath(): string {
  // When compiled: packages/evals/dist/e2e-infra/nanoclaw-smoke.js
  // When running via tsx: packages/evals/src/e2e-infra/nanoclaw-smoke.ts
  // We want:       packages/nanoclaw-channel/src/channels/moltzap.ts
  const here = fileURLToPath(import.meta.url);
  // Walk up to the packages/ directory regardless of dist/ vs src/ location.
  let current = path.dirname(here);
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") break;
    current = path.dirname(current);
  }
  return path.join(current, "nanoclaw-channel/src/channels/moltzap.ts");
}

function resolveSkillMdPath(): string {
  const here = fileURLToPath(import.meta.url);
  // Walk up to the repo root (one level above packages/)
  let current = path.dirname(here);
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") {
      current = path.dirname(current);
      break;
    }
    current = path.dirname(current);
  }
  return path.join(current, "SKILL.md");
}

/**
 * Re-sync the channel file into the warm cache when it has drifted from the
 * source of truth in packages/nanoclaw-channel/. Skips a full reinstall (which
 * takes 3–5 min) and just recompiles nanoclaw so the new channel.ts lands in
 * dist/. Called from ensureNanoclawInstalled when the ready marker exists.
 */
async function syncChannelFileIntoCache(): Promise<void> {
  const src = resolveChannelFilePath();
  const dst = path.join(NANOCLAW_CACHE, "src/channels/moltzap.ts");
  if (!fs.existsSync(src) || !fs.existsSync(dst)) return;

  const [srcContent, dstContent] = await Promise.all([
    fsp.readFile(src, "utf8"),
    fsp.readFile(dst, "utf8"),
  ]);
  if (srcContent === dstContent) return;

  logger.info("Channel file drift detected — syncing + rebuilding nanoclaw");
  await fsp.writeFile(dst, srcContent);
  await exec("npm run build", { cwd: NANOCLAW_CACHE, timeout: 120_000 });
}

export async function ensureNanoclawInstalled(): Promise<void> {
  const readyMarker = path.join(NANOCLAW_CACHE, ".ready");
  if (fs.existsSync(readyMarker)) {
    logger.info(`Nanoclaw smoke cache found at ${NANOCLAW_CACHE}`);
    await syncChannelFileIntoCache();
    return;
  }

  await preflightDocker();

  logger.info(
    `Installing nanoclaw@${NANOCLAW_SHA.slice(0, 12)} — this can take 3–5 minutes on first run...`,
  );

  const tmpDir = `${NANOCLAW_CACHE}.tmp`;
  await fsp.rm(tmpDir, { recursive: true, force: true });

  // Download upstream nanoclaw source
  logger.info("Downloading nanoclaw source...");
  await downloadTarball(NANOCLAW_URL, tmpDir);

  // Inject the moltzap channel file from packages/nanoclaw-channel/
  logger.info("Injecting moltzap channel file...");
  const channelFileSrc = resolveChannelFilePath();
  if (!fs.existsSync(channelFileSrc)) {
    throw new Error(
      `Expected channel file at ${channelFileSrc} — did you build @moltzap/nanoclaw-channel?`,
    );
  }
  await fsp.copyFile(
    channelFileSrc,
    path.join(tmpDir, "src/channels/moltzap.ts"),
  );

  // Append barrel import if missing. Idempotent, robust to upstream channel additions.
  const barrelPath = path.join(tmpDir, "src/channels/index.ts");
  const barrel = await fsp.readFile(barrelPath, "utf8");
  if (!barrel.includes("import './moltzap.js';")) {
    await fsp.writeFile(
      barrelPath,
      barrel.trimEnd() + "\n\nimport './moltzap.js';\n",
    );
  }

  // Copy the shared root SKILL.md into nanoclaw's container/skills tree
  // (container/skills/ is what nanoclaw's agent container mounts, NOT
  // .claude/skills/ which is the host-side dev tree).
  const skillMdSrc = resolveSkillMdPath();
  if (!fs.existsSync(skillMdSrc)) {
    throw new Error(
      `Expected shared SKILL.md at ${skillMdSrc} — repo layout change?`,
    );
  }
  await fsp.mkdir(path.join(tmpDir, "container/skills/moltzap"), {
    recursive: true,
  });
  await fsp.copyFile(
    skillMdSrc,
    path.join(tmpDir, "container/skills/moltzap/SKILL.md"),
  );

  // Install @moltzap/client from npm registry. Cli's own moltzap binary is
  // not needed inside the container; the channel file imports MoltZapService
  // from the package. The @latest tag resolves to whatever is published.
  logger.info("Installing @moltzap/client...");
  await exec(
    "npm install @moltzap/client@latest --no-package-lock --ignore-scripts",
    { cwd: tmpDir, timeout: 120_000 },
  );

  // Install nanoclaw's own deps. Do NOT use --ignore-scripts here: nanoclaw's
  // better-sqlite3 is a native module that must run its build script to compile
  // bindings against the host's node version. The smoke test accepts the supply
  // chain risk of lifecycle scripts running; the SHA pin bounds the exposure.
  logger.info("Installing nanoclaw dependencies...");
  await exec("npm install --no-package-lock", {
    cwd: tmpDir,
    timeout: 300_000,
  });

  // Compile nanoclaw + the injected channel file
  logger.info("Building nanoclaw...");
  await exec("npm run build", { cwd: tmpDir, timeout: 120_000 });

  // Build nanoclaw's agent container image (used by nanoclaw's container-runner
  // when spawning agent subcontainers at runtime). This runs vendored bash
  // from upstream — documented supply chain risk for the smoke test phase.
  logger.info("Building nanoclaw agent container image (~60s)...");
  await exec("bash container/build.sh", {
    cwd: tmpDir,
    timeout: 300_000,
  });

  // Atomic rename — only mark .ready on full success
  await fsp.rm(NANOCLAW_CACHE, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(NANOCLAW_CACHE), { recursive: true });
  await fsp.rename(tmpDir, NANOCLAW_CACHE);
  await fsp.writeFile(readyMarker, "");

  logger.info(`Nanoclaw smoke cache ready at ${NANOCLAW_CACHE}`);
}

export async function startNanoclawSmoke(opts: {
  apiKey: string;
  serverUrl: string;
  contextAdapter?: { type: "cross-conversation" };
}): Promise<NanoclawSmokeHandle> {
  const dataDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "moltzap-nanoclaw-smoke-"),
  );

  // @moltzap/client's MoltZapWsClient appends "/ws" and rewrites http→ws itself.
  // The eval runner hands us the already-expanded wsUrl (ws://host:port/ws),
  // so strip the suffix and flip the scheme to match what the client expects
  // as input — otherwise the client produces /ws/ws and the upgrade fails.
  const normalizedServerUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:");

  await ensureOnecliRunning();

  logger.info(
    `Starting nanoclaw subprocess (dataDir: ${dataDir}, server: ${normalizedServerUrl}, contextAdapter: ${opts.contextAdapter?.type ?? "none"})`,
  );

  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MOLTZAP_API_KEY: opts.apiKey,
    MOLTZAP_SERVER_URL: normalizedServerUrl,
    MOLTZAP_EVAL_MODE: "1",
    DATA_DIR: dataDir,
    CONTAINER_RUNTIME: "docker",
    ONECLI_URL: ONECLI_URL,
    LOG_LEVEL: "info",
  };
  if (opts.contextAdapter?.type === "cross-conversation") {
    childEnv.MOLTZAP_CONTEXT_ADAPTER = "cross-conversation";
  }

  const proc = spawn("node", ["dist/index.js"], {
    cwd: NANOCLAW_CACHE,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capturedLogs: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) =>
    capturedLogs.push(chunk.toString()),
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    capturedLogs.push(chunk.toString()),
  );

  // Wait for connection marker OR process exit, whichever comes first.
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(watcher);
      const tail = capturedLogs.join("").split("\n").slice(-50).join("\n");
      reject(
        new Error(
          `nanoclaw did not connect within ${CONNECT_TIMEOUT_MS / 1000}s.\nLast 50 log lines:\n${tail}`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);

    proc.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(watcher);
      const tail = capturedLogs.join("").split("\n").slice(-50).join("\n");
      reject(
        new Error(
          `nanoclaw exited before connecting (code=${code}, signal=${signal}).\nLast 50 log lines:\n${tail}`,
        ),
      );
    });

    const watcher = setInterval(() => {
      if (settled) return;
      const joined = capturedLogs.join("");
      if (CONNECTED_MARKER.test(joined)) {
        settled = true;
        clearTimeout(timeout);
        clearInterval(watcher);
        resolve();
      }
    }, 200);
  });

  logger.info("Nanoclaw subprocess connected to MoltZap server");
  return { proc, dataDir, capturedLogs };
}

export async function stopNanoclawSmoke(
  handle: NanoclawSmokeHandle,
): Promise<void> {
  logger.info("Stopping nanoclaw subprocess...");
  if (!handle.proc.killed) {
    handle.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, GRACEFUL_STOP_MS));
    if (!handle.proc.killed) {
      handle.proc.kill("SIGKILL");
    }
  }
  await fsp.rm(handle.dataDir, { recursive: true, force: true });
}

export function getNanoclawLogs(handle: NanoclawSmokeHandle): string {
  return handle.capturedLogs.join("");
}
