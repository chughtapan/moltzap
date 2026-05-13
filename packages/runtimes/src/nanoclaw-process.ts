/**
 * Internal nanoclaw runtime-process helpers for the trace-capture runtime adapter.
 *
 * This file owns the warm-cache install/bootstrap and subprocess lifecycle for
 * the nanoclaw runtime. It is intentionally kept under `runtimes/` so the
 * subprocess path stays a private adapter detail instead of a public package
 * surface.
 */
import { spawn, type ChildProcess, type ExecOptions } from "node:child_process";
import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import * as os from "node:os";
import * as path from "node:path";
import { env as hostEnv, execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Data, Duration, Effect } from "effect";
import {
  copyAsync,
  copyFileAsync,
  existsSync,
  makeDirectoryAsync,
  makeTempDirectoryAsync,
  readFileAsync,
  readFileStringAsync,
  renameAsync,
  removeAsync,
  unlinkAsync,
  writeFileAsync,
} from "./node-fs.js";

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
const NANOCLAW_SHA = ["934f063aff5c30e7b49c", "e58b53b41901d3472a3e"].join("");
const NANOCLAW_URL = `https://github.com/qwibitai/nanoclaw/archive/${NANOCLAW_SHA}.tar.gz`;
const STRING_START_INDEX = 0;
const NANOCLAW_CACHE_KEY_LENGTH = 12;

const NANOCLAW_RUNTIME_CACHE = path.join(
  os.homedir(),
  ".cache/moltzap-runtimes/nanoclaw",
  NANOCLAW_SHA.slice(STRING_START_INDEX, NANOCLAW_CACHE_KEY_LENGTH),
);

// Log marker: the moltzap channel in packages/nanoclaw-channel/src/moltzap.ts
// emits "MoltZap connected" via the logger on successful connect. Anchoring
// against an "info" prefix reduces false positives from quoted error text.
const CONNECTED_MARKER = /\[info\].*MoltZap connected|MoltZap connected/;

const CONNECT_TIMEOUT_MS = 60_000;
const GRACEFUL_STOP_MS = 3_000;
const ONECLI_PROBE_TIMEOUT_MS = 2_000;
const ONECLI_READY_PROBE_LIMIT = 20;
const ONECLI_READY_PROBE_INTERVAL = "500 millis";
const CONNECT_WATCH_INTERVAL_MS = 200;
const LOG_TAIL_LINE_COUNT = 50;
const MILLISECONDS_PER_SECOND = 1_000;

export interface NanoclawRuntimeHandle {
  proc: ChildProcess;
  dataDir: string;
  capturedLogs: string[];
}

interface StartNanoclawRuntimeOptions {
  apiKey: string;
  serverUrl: string;
  workspaceFiles?: ReadonlyArray<{
    relativePath: string;
    content: string;
  }>;
}

class NanoclawRuntimeProcessError extends Data.TaggedError(
  "NanoclawRuntimeProcessError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

function toRuntimeError(message: string, cause?: unknown) {
  return new NanoclawRuntimeProcessError({
    reason: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function execEffect(
  command: string,
  options?: ExecOptions,
): Effect.Effect<void, NanoclawRuntimeProcessError> {
  return Effect.tryPromise({
    try: () => exec(command, options),
    catch: (cause) => toRuntimeError(`command failed: ${command}`, cause),
  }).pipe(Effect.asVoid);
}

function promiseEffect<T>(
  reason: string,
  run: () => PromiseLike<T>,
): Effect.Effect<T, NanoclawRuntimeProcessError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toRuntimeError(reason, cause),
  });
}

function isOnecliReachable(): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client.execute(
      HttpClientRequest.get(`${ONECLI_URL}/api/container-config`),
    );
    return true;
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(ONECLI_PROBE_TIMEOUT_MS),
      onTimeout: () => new Error("OneCLI reachability probe timed out"),
    }),
    Effect.provide(NodeHttpClient.layer),
    Effect.catchAll((reachabilityErr) =>
      reachabilityErr instanceof Error &&
      reachabilityErr.message.includes("timed out")
        ? Effect.succeed(false)
        : Effect.logWarning(
            "failed to probe OneCLI reachability",
            reachabilityErr,
          ).pipe(Effect.as(false)),
    ),
  );
}

function ensureOnecliRunning(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    const reachable = yield* isOnecliReachable();
    if (reachable) return;

    if (!existsSync(ONECLI_COMPOSE_PATH)) {
      return yield* Effect.fail(
        toRuntimeError(
          `OneCLI gateway not running and not installed at ${ONECLI_COMPOSE_PATH}. ` +
            `Nanoclaw requires OneCLI to inject credentials into agent subcontainers. ` +
            `Install once with:\n\n  curl -fsSL https://onecli.sh/install | sh\n\n` +
            `Then open http://127.0.0.1:10254 and add your Anthropic credentials.`,
        ),
      );
    }

    yield* execEffect(
      `docker compose -p onecli -f "${ONECLI_COMPOSE_PATH}" up -d --wait`,
      { timeout: 120_000 },
    );

    // `--wait` returns when healthchecks pass, but give the HTTP listener a
    // moment to bind before the first real request.
    for (let i = 0; i < ONECLI_READY_PROBE_LIMIT; i++) {
      if (yield* isOnecliReachable()) {
        return;
      }
      yield* Effect.sleep(ONECLI_READY_PROBE_INTERVAL);
    }

    return yield* Effect.fail(
      toRuntimeError(
        `OneCLI gateway started but not reachable at ${ONECLI_URL} after 10s. ` +
          `Check: docker compose -p onecli -f ${ONECLI_COMPOSE_PATH} logs`,
      ),
    );
  });
}

function preflightDocker(): Effect.Effect<void, NanoclawRuntimeProcessError> {
  return execEffect("docker info", { timeout: 5_000 }).pipe(
    Effect.asVoid,
    Effect.mapError((err) =>
      toRuntimeError(
        "Nanoclaw runtime requires docker to be running on the host " +
          "(nanoclaw spawns agent subcontainers via its container-runner). " +
          `docker info failed: ${err.message}`,
        err,
      ),
    ),
  );
}

function downloadTarball(
  url: string,
  destDir: string,
): Effect.Effect<void, NanoclawRuntimeProcessError> {
  return Effect.gen(function* () {
    yield* promiseEffect(`create nanoclaw download directory ${destDir}`, () =>
      makeDirectoryAsync(destDir, { recursive: true }),
    );
    const tarballPath = path.join(destDir, "nanoclaw.tar.gz");

    // Use curl for streaming + redirect handling. The eval host has curl.
    yield* execEffect(`curl -fsSL "${url}" -o "${tarballPath}"`, {
      timeout: 60_000,
    });

    // Extract with --strip-components=1 so the archive's top-level
    // nanoclaw-<sha>/ directory collapses into destDir itself.
    yield* execEffect(
      `tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1`,
      {
        timeout: 30_000,
      },
    );

    yield* promiseEffect(
      `remove downloaded nanoclaw tarball ${tarballPath}`,
      () => unlinkAsync(tarballPath),
    );
  });
}

function resolveChannelFilePath(): string {
  // When compiled: packages/runtimes/dist/nanoclaw-process.js
  // When running via tsx: packages/runtimes/src/nanoclaw-process.ts
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

function sha256OfFile(
  filePath: string,
): Effect.Effect<string, NanoclawRuntimeProcessError> {
  return promiseEffect(`read file for sha256 ${filePath}`, () =>
    readFileAsync(filePath),
  ).pipe(Effect.map((buf) => createHash("sha256").update(buf).digest("hex")));
}

function channelFileDrift(): Effect.Effect<
  {
    src: string;
    dst: string;
    content: string;
  } | null,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    const src = resolveChannelFilePath();
    const dst = path.join(NANOCLAW_RUNTIME_CACHE, "src/channels/moltzap.ts");
    if (!existsSync(src) || !existsSync(dst)) return null;
    const srcContent = yield* promiseEffect(
      `read source channel file ${src}`,
      () => readFileStringAsync(src, "utf8"),
    );
    const dstContent = yield* promiseEffect(
      `read cached channel file ${dst}`,
      () => readFileStringAsync(dst, "utf8"),
    );
    return srcContent === dstContent ? null : { src, dst, content: srcContent };
  });
}

function clientDistDrift(): Effect.Effect<
  {
    src: string;
    dst: string;
  } | null,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    const src = resolveClientDistPath();
    const dst = path.join(
      NANOCLAW_RUNTIME_CACHE,
      "node_modules/@moltzap/client/dist",
    );
    if (!existsSync(src) || !existsSync(dst)) return null;
    const srcCoreJs = path.join(src, "channel-core.js");
    const dstCoreJs = path.join(dst, "channel-core.js");
    if (!existsSync(dstCoreJs)) return { src, dst };
    const srcHash = yield* sha256OfFile(srcCoreJs);
    const dstHash = yield* sha256OfFile(dstCoreJs);
    return srcHash === dstHash ? null : { src, dst };
  });
}

/**
 * Re-sync workspace channel file + @moltzap/client dist into the warm cache
 * when either has drifted, then rebuild nanoclaw. Caller must ensure the
 * workspace @moltzap/client has been freshly built.
 */
function syncChannelFileIntoCache(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    const chDrift = yield* channelFileDrift();
    const clDrift = yield* clientDistDrift();

    if (chDrift) {
      yield* promiseEffect(`write cached channel file ${chDrift.dst}`, () =>
        writeFileAsync(chDrift.dst, chDrift.content),
      );
    }

    if (clDrift) {
      yield* promiseEffect(
        `copy @moltzap/client dist into runtime cache ${clDrift.dst}`,
        () => copyAsync(clDrift.src, clDrift.dst, { recursive: true }),
      );
    }

    if (chDrift || clDrift) {
      yield* execEffect("npm run build", {
        cwd: NANOCLAW_RUNTIME_CACHE,
        timeout: 120_000,
      });
    }
  });
}

export function ensureNanoclawRuntimeInstalled() {
  return Effect.runPromise(ensureNanoclawRuntimeInstalledEffect());
}

function ensureNanoclawRuntimeInstalledEffect(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError
> {
  return Effect.gen(function* () {
    const readyMarker = path.join(NANOCLAW_RUNTIME_CACHE, ".ready");
    if (existsSync(readyMarker)) {
      yield* syncChannelFileIntoCache();
      return;
    }

    yield* preflightDocker();

    const tmpDir = `${NANOCLAW_RUNTIME_CACHE}.tmp`;
    yield* promiseEffect(`remove nanoclaw temp cache ${tmpDir}`, () =>
      removeAsync(tmpDir, { recursive: true, force: true }),
    );

    // Download upstream nanoclaw source
    yield* downloadTarball(NANOCLAW_URL, tmpDir);

    // Inject the moltzap channel file from packages/nanoclaw-channel/
    const channelFileSrc = resolveChannelFilePath();
    if (!existsSync(channelFileSrc)) {
      return yield* Effect.fail(
        toRuntimeError(
          `Expected channel file at ${channelFileSrc} — did you build @moltzap/nanoclaw-channel?`,
        ),
      );
    }
    yield* promiseEffect(
      `copy moltzap channel file into nanoclaw cache ${channelFileSrc}`,
      () =>
        copyFileAsync(
          channelFileSrc,
          path.join(tmpDir, "src/channels/moltzap.ts"),
        ),
    );

    // Append barrel import if missing. Idempotent, robust to upstream channel additions.
    const barrelPath = path.join(tmpDir, "src/channels/index.ts");
    const barrel = yield* promiseEffect(
      `read nanoclaw channel barrel ${barrelPath}`,
      () => readFileStringAsync(barrelPath, "utf8"),
    );
    if (!barrel.includes("import './moltzap.js';")) {
      yield* promiseEffect(`write nanoclaw channel barrel ${barrelPath}`, () =>
        writeFileAsync(
          barrelPath,
          barrel.trimEnd() + "\n\nimport './moltzap.js';\n",
        ),
      );
    }

    // Copy the shared root SKILL.md into nanoclaw's container/skills tree
    // (container/skills/ is what nanoclaw's agent container mounts, NOT
    // .claude/skills/ which is the host-side dev tree).
    const skillMdSrc = resolveSkillMdPath();
    if (!existsSync(skillMdSrc)) {
      return yield* Effect.fail(
        toRuntimeError(
          `Expected shared SKILL.md at ${skillMdSrc} — repo layout change?`,
        ),
      );
    }
    yield* promiseEffect("create nanoclaw moltzap skill directory", () =>
      makeDirectoryAsync(path.join(tmpDir, "container/skills/moltzap"), {
        recursive: true,
      }),
    );
    yield* promiseEffect(
      `copy shared SKILL.md into nanoclaw cache ${skillMdSrc}`,
      () =>
        copyFileAsync(
          skillMdSrc,
          path.join(tmpDir, "container/skills/moltzap/SKILL.md"),
        ),
    );

    // Install @moltzap/client from npm registry. Cli's own moltzap binary is
    // not needed inside the container; the channel file imports MoltZapService
    // from the package. The @latest tag resolves to whatever is published.
    yield* execEffect(
      "npm install @moltzap/client@latest --no-package-lock --ignore-scripts",
      { cwd: tmpDir, timeout: 120_000 },
    );

    // Install nanoclaw's own deps. Do NOT use --ignore-scripts here: nanoclaw's
    // better-sqlite3 is a native module that must run its build script to compile
    // bindings against the host's node version. The smoke test accepts the supply
    // chain risk of lifecycle scripts running; the SHA pin bounds the exposure.
    yield* execEffect("npm install --no-package-lock", {
      cwd: tmpDir,
      timeout: 300_000,
    });

    // Compile nanoclaw + the injected channel file
    yield* execEffect("npm run build", { cwd: tmpDir, timeout: 120_000 });

    // Build nanoclaw's agent container image (used by nanoclaw's container-runner
    // when spawning agent subcontainers at runtime). This runs vendored bash
    // from upstream — documented supply chain risk for the smoke test phase.
    yield* execEffect("bash container/build.sh", {
      cwd: tmpDir,
      timeout: 300_000,
    });

    // Atomic rename — only mark .ready on full success
    yield* promiseEffect(
      `remove stale nanoclaw cache ${NANOCLAW_RUNTIME_CACHE}`,
      () =>
        removeAsync(NANOCLAW_RUNTIME_CACHE, { recursive: true, force: true }),
    );
    yield* promiseEffect("create nanoclaw cache parent directory", () =>
      makeDirectoryAsync(path.dirname(NANOCLAW_RUNTIME_CACHE), {
        recursive: true,
      }),
    );
    yield* promiseEffect("promote nanoclaw temp cache into ready cache", () =>
      renameAsync(tmpDir, NANOCLAW_RUNTIME_CACHE),
    );
    yield* promiseEffect(`write nanoclaw ready marker ${readyMarker}`, () =>
      writeFileAsync(readyMarker, ""),
    );
  });
}

export function startNanoclawRuntime(opts: StartNanoclawRuntimeOptions) {
  return Effect.runPromise(startNanoclawRuntimeEffect(opts));
}

function startNanoclawRuntimeEffect(
  opts: StartNanoclawRuntimeOptions,
): Effect.Effect<NanoclawRuntimeHandle, NanoclawRuntimeProcessError> {
  return Effect.gen(function* () {
    const dataDir = yield* promiseEffect(
      "create nanoclaw runtime data dir",
      () =>
        makeTempDirectoryAsync(
          path.join(os.tmpdir(), "moltzap-nanoclaw-runtime-"),
        ),
    );

    // @moltzap/client's MoltZapWsClient appends "/ws" and rewrites http→ws itself.
    // The eval runner hands us the already-expanded wsUrl (ws://host:port/ws),
    // so strip the suffix and flip the scheme to match what the client expects
    // as input — otherwise the client produces /ws/ws and the upgrade fails.
    const normalizedServerUrl = opts.serverUrl
      .replace(/\/ws$/, "")
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:");

    yield* ensureOnecliRunning();
    if (opts.workspaceFiles !== undefined) {
      const workspaceRoot = path.join(
        NANOCLAW_RUNTIME_CACHE,
        "container/skills",
      );
      for (const file of opts.workspaceFiles) {
        const destination = path.join(workspaceRoot, file.relativePath);
        yield* promiseEffect(
          `create workspace file directory ${path.dirname(destination)}`,
          () =>
            makeDirectoryAsync(path.dirname(destination), { recursive: true }),
        );
        yield* promiseEffect(`write workspace file ${destination}`, () =>
          writeFileAsync(destination, file.content),
        );
      }
    }

    const proc = yield* Effect.try({
      try: () =>
        spawn(execPath, ["dist/index.js"], {
          cwd: NANOCLAW_RUNTIME_CACHE,
          env: {
            ...hostEnv,
            MOLTZAP_API_KEY: opts.apiKey,
            MOLTZAP_SERVER_URL: normalizedServerUrl,
            MOLTZAP_EVAL_MODE: "1",
            DATA_DIR: dataDir,
            CONTAINER_RUNTIME: "docker",
            ONECLI_URL: ONECLI_URL,
            LOG_LEVEL: "info",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      catch: (cause) => toRuntimeError("spawn nanoclaw runtime", cause),
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
    const waitForConnection = Effect.async<void, NanoclawRuntimeProcessError>(
      (resume) => {
        let settled = false;
        let watcher: ReturnType<typeof setInterval> | null = null;

        const clearWatcher = (): void => {
          if (watcher !== null) {
            clearInterval(watcher);
            watcher = null;
          }
        };

        const settle = (
          r: Effect.Effect<void, NanoclawRuntimeProcessError>,
        ): void => {
          if (settled) return;
          settled = true;
          clearWatcher();
          proc.removeListener("exit", onExit);
          resume(r);
        };

        const onExit = (code: number | null, signal: string | null): void => {
          const tail = capturedLogs
            .join("")
            .split("\n")
            .slice(-LOG_TAIL_LINE_COUNT)
            .join("\n");
          settle(
            Effect.fail(
              toRuntimeError(
                `nanoclaw runtime exited before connecting (code=${code}, signal=${signal}).\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${tail}`,
              ),
            ),
          );
        };

        proc.on("exit", onExit);

        watcher = setInterval(() => {
          const joined = capturedLogs.join("");
          if (CONNECTED_MARKER.test(joined)) settle(Effect.void);
        }, CONNECT_WATCH_INTERVAL_MS);

        // Cleanup if interrupted (e.g. outer timeout fires).
        return Effect.sync(() => {
          if (!settled) {
            settled = true;
            clearWatcher();
            proc.removeListener("exit", onExit);
          }
        });
      },
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(CONNECT_TIMEOUT_MS),
        onTimeout: () => {
          const tail = capturedLogs
            .join("")
            .split("\n")
            .slice(-LOG_TAIL_LINE_COUNT)
            .join("\n");
          return toRuntimeError(
            `nanoclaw runtime did not connect within ${
              CONNECT_TIMEOUT_MS / MILLISECONDS_PER_SECOND
            }s.\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${tail}`,
          );
        },
      }),
    );
    yield* waitForConnection;
    return { proc, dataDir, capturedLogs };
  });
}

export function stopNanoclawRuntime(handle: NanoclawRuntimeHandle) {
  return Effect.runPromise(stopNanoclawRuntimeEffect(handle));
}

function stopNanoclawRuntimeEffect(
  handle: NanoclawRuntimeHandle,
): Effect.Effect<void, NanoclawRuntimeProcessError> {
  return Effect.gen(function* () {
    if (!handle.proc.killed) {
      yield* Effect.try({
        try: () => {
          handle.proc.kill("SIGTERM");
        },
        catch: (cause) => toRuntimeError("terminate nanoclaw runtime", cause),
      });
      yield* Effect.sleep(Duration.millis(GRACEFUL_STOP_MS));
      if (!handle.proc.killed) {
        yield* Effect.try({
          try: () => {
            handle.proc.kill("SIGKILL");
          },
          catch: (cause) => toRuntimeError("kill nanoclaw runtime", cause),
        });
      }
    }
    yield* promiseEffect(`remove nanoclaw data dir ${handle.dataDir}`, () =>
      removeAsync(handle.dataDir, { recursive: true, force: true }),
    );
  });
}

export function getNanoclawRuntimeLogs(handle: NanoclawRuntimeHandle): string {
  return handle.capturedLogs.join("");
}
