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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Duration, Effect } from "effect";

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

export const NANOCLAW_CACHE = path.join(
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

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: fetch + Docker exec boundary
async function isOnecliReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ONECLI_URL}/api/container-config`, {
      signal: AbortSignal.timeout(2_000),
    });
    // Any HTTP response means the dashboard is listening. A 401/403 is fine —
    // nanoclaw's SDK handles auth. We only care that the port is open.
    return res.status > 0;
  } catch (err) {
    logger.debug(
      `OneCLI gateway unreachable at ${ONECLI_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: Docker compose exec boundary
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

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: Docker exec boundary
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

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: curl subshell boundary
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

function resolveClientDistPath(): string {
  const here = fileURLToPath(import.meta.url);
  let current = path.dirname(here);
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") break;
    current = path.dirname(current);
  }
  return path.join(current, "client/dist");
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: fs.readFile boundary
async function sha1OfFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return createHash("sha1").update(buf).digest("hex");
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: fs.readFile boundary
async function channelFileDrift(): Promise<{
  src: string;
  dst: string;
  content: string;
} | null> {
  const src = resolveChannelFilePath();
  const dst = path.join(NANOCLAW_CACHE, "src/channels/moltzap.ts");
  if (!fs.existsSync(src) || !fs.existsSync(dst)) return null;
  const [srcContent, dstContent] = await Promise.all([
    fsp.readFile(src, "utf8"),
    fsp.readFile(dst, "utf8"),
  ]);
  return srcContent === dstContent ? null : { src, dst, content: srcContent };
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: fs stat boundary
async function clientDistDrift(): Promise<{
  src: string;
  dst: string;
} | null> {
  const src = resolveClientDistPath();
  const dst = path.join(NANOCLAW_CACHE, "node_modules/@moltzap/client/dist");
  if (!fs.existsSync(src) || !fs.existsSync(dst)) return null;
  const srcCoreJs = path.join(src, "channel-core.js");
  const dstCoreJs = path.join(dst, "channel-core.js");
  if (!fs.existsSync(dstCoreJs)) return { src, dst };
  const [srcHash, dstHash] = await Promise.all([
    sha1OfFile(srcCoreJs),
    sha1OfFile(dstCoreJs),
  ]);
  return srcHash === dstHash ? null : { src, dst };
}

/**
 * Re-sync workspace channel file + @moltzap/client dist into the warm cache
 * when either has drifted, then rebuild nanoclaw. Caller must ensure the
 * workspace @moltzap/client has been freshly built.
 */
// #ignore-sloppy-code-next-line[async-keyword, promise-type]: fs + npm exec boundary
async function syncChannelFileIntoCache(): Promise<void> {
  const [chDrift, clDrift] = await Promise.all([
    channelFileDrift(),
    clientDistDrift(),
  ]);

  if (chDrift) {
    logger.info("Channel file drift detected — syncing");
    await fsp.writeFile(chDrift.dst, chDrift.content);
  }

  if (clDrift) {
    logger.info(
      "@moltzap/client dist drift detected — syncing compiled tree into cache",
    );
    await fsp.cp(clDrift.src, clDrift.dst, { recursive: true });
  }

  if (chDrift || clDrift) {
    logger.info("Rebuilding nanoclaw after sync");
    await exec("npm run build", { cwd: NANOCLAW_CACHE, timeout: 120_000 });
  }
}

// #ignore-sloppy-code-next-line[async-keyword, promise-type]: npm install + docker build orchestration boundary
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

// #ignore-sloppy-code-next-line[async-keyword]: node child_process.spawn boundary
export async function startNanoclawSmoke(opts: {
  apiKey: string;
  serverUrl: string;
  // #ignore-sloppy-code-next-line[promise-type]: node child_process.spawn boundary
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
    `Starting nanoclaw subprocess (dataDir: ${dataDir}, server: ${normalizedServerUrl})`,
  );

  const proc = spawn("node", ["dist/index.js"], {
    cwd: NANOCLAW_CACHE,
    env: {
      ...process.env,
      MOLTZAP_API_KEY: opts.apiKey,
      MOLTZAP_SERVER_URL: normalizedServerUrl,
      MOLTZAP_EVAL_MODE: "1",
      DATA_DIR: dataDir,
      CONTAINER_RUNTIME: "docker",
      ONECLI_URL: ONECLI_URL,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capturedLogs: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) =>
    capturedLogs.push(chunk.toString()),
  );
  proc.stderr?.on("data", (chunk: Buffer) =>
    capturedLogs.push(chunk.toString()),
  );

  // Race three events for readiness: connect-marker seen, process exit, or
  // overall timeout. The Effect constructor below adapts these callback-based
  // sources with a finalizer that always clears the watcher interval.
  const waitForConnection = Effect.async<void, Error>((resume) => {
    let settled = false;
    const settle = (r: Effect.Effect<void, Error>): void => {
      if (settled) return;
      settled = true;
      clearInterval(watcher);
      proc.removeListener("exit", onExit);
      resume(r);
    };

    const onExit = (code: number | null, signal: string | null): void => {
      const tail = capturedLogs.join("").split("\n").slice(-50).join("\n");
      settle(
        Effect.fail(
          new Error(
            `nanoclaw exited before connecting (code=${code}, signal=${signal}).\nLast 50 log lines:\n${tail}`,
          ),
        ),
      );
    };

    proc.on("exit", onExit);

    const watcher = setInterval(() => {
      const joined = capturedLogs.join("");
      if (CONNECTED_MARKER.test(joined)) settle(Effect.void);
    }, 200);

    // Cleanup if interrupted (e.g. outer timeout fires).
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        clearInterval(watcher);
        proc.removeListener("exit", onExit);
      }
    });
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(CONNECT_TIMEOUT_MS),
      onTimeout: () => {
        const tail = capturedLogs.join("").split("\n").slice(-50).join("\n");
        return new Error(
          `nanoclaw did not connect within ${CONNECT_TIMEOUT_MS / 1000}s.\nLast 50 log lines:\n${tail}`,
        );
      },
    }),
  );
  await Effect.runPromise(waitForConnection);

  logger.info("Nanoclaw subprocess connected to MoltZap server");
  return { proc, dataDir, capturedLogs };
}

// #ignore-sloppy-code-next-line[async-keyword]: child_process kill + fs.rm boundary
export async function stopNanoclawSmoke(
  handle: NanoclawSmokeHandle,
  // #ignore-sloppy-code-next-line[promise-type]: child_process kill + fs.rm boundary
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
