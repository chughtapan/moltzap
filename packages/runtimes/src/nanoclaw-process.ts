/**
 * Internal nanoclaw runtime-process helpers for the trace-capture runtime adapter.
 *
 * This file owns the warm-cache install/bootstrap and subprocess lifecycle for
 * the nanoclaw runtime. It is intentionally kept under `runtimes/` so the
 * subprocess path stays a private adapter detail instead of a public package
 * surface.
 */
import {
  Command,
  FileSystem,
  HttpClient,
  HttpClientRequest,
  Path,
} from "@effect/platform";
import type { Process, Signal } from "@effect/platform/CommandExecutor";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  Scope,
  Stream,
} from "effect";

// OneCLI gateway — nanoclaw's container-runner calls this for per-container
// credential injection. Running locally from ~/.onecli/docker-compose.yml,
// dashboard on 10254, gateway on 10255. Install: curl -fsSL https://onecli.sh/install | sh
const ONECLI_URL = "http://127.0.0.1:10254";
const ONECLI_COMPOSE_PATH = pathSync((path) =>
  path.join(homeDirSync(), ".onecli/docker-compose.yml"),
);

// Pinned to qwibitai/nanoclaw@934f063 (2026-04-10). Bump deliberately.
const NANOCLAW_SHA = ["934f063aff5c30e7b49c", "e58b53b41901d3472a3e"].join("");
const NANOCLAW_URL = `https://github.com/qwibitai/nanoclaw/archive/${NANOCLAW_SHA}.tar.gz`;
const STRING_START_INDEX = 0;
const NANOCLAW_CACHE_KEY_LENGTH = 12;

const NANOCLAW_RUNTIME_CACHE = pathSync((path) =>
  path.join(
    homeDirSync(),
    ".cache/moltzap-runtimes/nanoclaw",
    NANOCLAW_SHA.slice(STRING_START_INDEX, NANOCLAW_CACHE_KEY_LENGTH),
  ),
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
const HEX_RADIX = 16;
const HEX_BYTE_PAD = 2;
const SHA_256 = "SHA-256";

export interface NanoclawRuntimeHandle {
  proc: Process;
  scope: Scope.CloseableScope;
  exitFiber: Fiber.RuntimeFiber<number, never>;
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

interface CommandRunOptions {
  readonly cwd?: string;
  readonly timeout?: number;
}

function toRuntimeError(message: string, cause?: unknown) {
  return new NanoclawRuntimeProcessError({
    reason: message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function homeDirSync(): string {
  return Effect.runSync(
    Config.string("HOME").pipe(
      Effect.withConfigProvider(ConfigProvider.fromEnv()),
    ),
  );
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
}

function pathEffectSync<A>(effect: Effect.Effect<A, unknown, Path.Path>): A {
  return Effect.runSync(effect.pipe(Effect.provide(Path.layer), Effect.orDie));
}

function workspacePackagesDir(): string {
  return pathEffectSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL(import.meta.url));
      let current = path.dirname(here);
      while (current !== path.parse(current).root) {
        if (path.basename(current) === "packages") {
          return current;
        }
        current = path.dirname(current);
      }
      return yield* Effect.fail(
        toRuntimeError("Unable to resolve workspace packages directory"),
      );
    }),
  );
}

function execEffect(
  commandText: string,
  options?: CommandRunOptions,
): Effect.Effect<void, NanoclawRuntimeProcessError> {
  const command =
    options?.cwd === undefined
      ? Command.make(commandText).pipe(Command.runInShell(true))
      : Command.make(commandText).pipe(
          Command.runInShell(true),
          Command.workingDirectory(options.cwd),
        );

  const exitCode =
    options?.timeout === undefined
      ? Command.exitCode(command)
      : Command.exitCode(command).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(options.timeout),
            onTimeout: () =>
              toRuntimeError(
                `command timed out after ${options.timeout}ms: ${commandText}`,
              ),
          }),
        );

  return exitCode.pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : Effect.fail(
            toRuntimeError(
              `command failed with exit code ${code}: ${commandText}`,
            ),
          ),
    ),
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof NanoclawRuntimeProcessError
        ? cause
        : toRuntimeError(`command failed: ${commandText}`, cause),
    ),
  );
}

const UTF8_DECODER = new TextDecoder("utf-8");

function consumeProcessStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  capturedLogs: string[],
): Effect.Effect<void, never, never> {
  return Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      capturedLogs.push(UTF8_DECODER.decode(chunk));
    }),
  ).pipe(Effect.catchAll(() => Effect.void));
}

function logTail(capturedLogs: readonly string[]): string {
  return capturedLogs
    .join("")
    .split("\n")
    .slice(-LOG_TAIL_LINE_COUNT)
    .join("\n");
}

function killProcessAndWait(
  proc: Process,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<boolean, never, never> {
  return proc.kill(signal).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

function sha256(
  data: Uint8Array,
): Effect.Effect<string, NanoclawRuntimeProcessError> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return Effect.fail(
      toRuntimeError("Runtime crypto.subtle is not available"),
    );
  }
  return Effect.tryPromise({
    try: () => subtle.digest(SHA_256, new Uint8Array(data)),
    catch: (cause) => toRuntimeError("sha256 digest failed", cause),
  }).pipe(Effect.map(hexDigest));
}

function hexDigest(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_PAD, "0"))
    .join("");
}

function fsEffect<T>(
  reason: string,
  effect: Effect.Effect<T, PlatformError>,
): Effect.Effect<T, NanoclawRuntimeProcessError> {
  return effect.pipe(Effect.mapError((cause) => toRuntimeError(reason, cause)));
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
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const reachable = yield* isOnecliReachable();
    if (reachable) return;

    const fileSystem = yield* FileSystem.FileSystem;
    const composeFileExists = yield* fsEffect(
      `check OneCLI compose file ${ONECLI_COMPOSE_PATH}`,
      fileSystem.exists(ONECLI_COMPOSE_PATH),
    );
    if (!composeFileExists) {
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
): Effect.Effect<void, NanoclawRuntimeProcessError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fsEffect(
      `create nanoclaw download directory ${destDir}`,
      fileSystem.makeDirectory(destDir, { recursive: true }),
    );
    const tarballPath = pathSync((path) =>
      path.join(destDir, "nanoclaw.tar.gz"),
    );

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

    yield* fsEffect(
      `remove downloaded nanoclaw tarball ${tarballPath}`,
      fileSystem.remove(tarballPath),
    );
  });
}

function resolveChannelFilePath(): string {
  return pathSync((path) =>
    path.join(
      workspacePackagesDir(),
      "nanoclaw-channel/src/channels/moltzap.ts",
    ),
  );
}

function resolveSkillMdPath(): string {
  return pathSync((path) =>
    path.join(path.dirname(workspacePackagesDir()), "SKILL.md"),
  );
}

function resolveClientDistPath(): string {
  return pathSync((path) => path.join(workspacePackagesDir(), "client/dist"));
}

function sha256OfFile(
  filePath: string,
): Effect.Effect<string, NanoclawRuntimeProcessError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        `read file for sha256 ${filePath}`,
        fileSystem.readFile(filePath),
      ),
    ),
    Effect.flatMap(sha256),
  );
}

function channelFileDrift(): Effect.Effect<
  {
    src: string;
    dst: string;
    content: string;
  } | null,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const src = resolveChannelFilePath();
    const dst = pathSync((path) =>
      path.join(NANOCLAW_RUNTIME_CACHE, "src/channels/moltzap.ts"),
    );
    const srcExists = yield* fsEffect(
      `check channel source file ${src}`,
      fileSystem.exists(src),
    );
    const dstExists = yield* fsEffect(
      `check cached channel file ${dst}`,
      fileSystem.exists(dst),
    );
    if (!srcExists || !dstExists) return null;
    const srcContent = yield* fsEffect(
      `read source channel file ${src}`,
      fileSystem.readFileString(src, "utf8"),
    );
    const dstContent = yield* fsEffect(
      `read cached channel file ${dst}`,
      fileSystem.readFileString(dst, "utf8"),
    );
    return srcContent === dstContent ? null : { src, dst, content: srcContent };
  });
}

function clientDistDrift(): Effect.Effect<
  {
    src: string;
    dst: string;
  } | null,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const src = resolveClientDistPath();
    const dst = pathSync((path) =>
      path.join(NANOCLAW_RUNTIME_CACHE, "node_modules/@moltzap/client/dist"),
    );
    const srcExists = yield* fsEffect(
      `check client dist ${src}`,
      fileSystem.exists(src),
    );
    const dstExists = yield* fsEffect(
      `check cached client dist ${dst}`,
      fileSystem.exists(dst),
    );
    if (!srcExists || !dstExists) return null;
    const srcCoreJs = pathSync((path) => path.join(src, "channel-core.js"));
    const dstCoreJs = pathSync((path) => path.join(dst, "channel-core.js"));
    const dstCoreExists = yield* fsEffect(
      `check cached client channel core ${dstCoreJs}`,
      fileSystem.exists(dstCoreJs),
    );
    if (!dstCoreExists) return { src, dst };
    const srcHash = yield* sha256OfFile(srcCoreJs);
    const dstHash = yield* sha256OfFile(dstCoreJs);
    return srcHash === dstHash ? null : { src, dst };
  });
}

/**
 * Re-sync workspace channel file + `@moltzap/client` dist into the warm cache
 * when either has drifted, then rebuild nanoclaw. Caller must ensure the
 * workspace `@moltzap/client` has been freshly built.
 */
function syncChannelFileIntoCache(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const chDrift = yield* channelFileDrift();
    const clDrift = yield* clientDistDrift();

    if (chDrift) {
      yield* fsEffect(
        `write cached channel file ${chDrift.dst}`,
        fileSystem.writeFileString(chDrift.dst, chDrift.content),
      );
    }

    if (clDrift) {
      yield* fsEffect(
        `copy @moltzap/client dist into runtime cache ${clDrift.dst}`,
        fileSystem.copy(clDrift.src, clDrift.dst, { overwrite: true }),
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

export function ensureNanoclawRuntimeInstalledEffect(): Effect.Effect<
  void,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readyMarker = pathSync((path) =>
      path.join(NANOCLAW_RUNTIME_CACHE, ".ready"),
    );
    const ready = yield* fsEffect(
      `check nanoclaw ready marker ${readyMarker}`,
      fileSystem.exists(readyMarker),
    );
    if (ready) {
      yield* syncChannelFileIntoCache();
      return;
    }

    yield* preflightDocker();

    const tmpDir = `${NANOCLAW_RUNTIME_CACHE}.tmp`;
    yield* fsEffect(
      `remove nanoclaw temp cache ${tmpDir}`,
      fileSystem.remove(tmpDir, { recursive: true, force: true }),
    );

    // Download upstream nanoclaw source
    yield* downloadTarball(NANOCLAW_URL, tmpDir);

    // Inject the moltzap channel file from packages/nanoclaw-channel/
    const channelFileSrc = resolveChannelFilePath();
    const channelFileExists = yield* fsEffect(
      `check moltzap channel file ${channelFileSrc}`,
      fileSystem.exists(channelFileSrc),
    );
    if (!channelFileExists) {
      return yield* Effect.fail(
        toRuntimeError(
          `Expected channel file at ${channelFileSrc} — did you build @moltzap/nanoclaw-channel?`,
        ),
      );
    }
    yield* fsEffect(
      `copy moltzap channel file into nanoclaw cache ${channelFileSrc}`,
      fileSystem.copyFile(
        channelFileSrc,
        pathSync((path) => path.join(tmpDir, "src/channels/moltzap.ts")),
      ),
    );

    // Append barrel import if missing. Idempotent, robust to upstream channel additions.
    const barrelPath = pathSync((path) =>
      path.join(tmpDir, "src/channels/index.ts"),
    );
    const barrel = yield* fsEffect(
      `read nanoclaw channel barrel ${barrelPath}`,
      fileSystem.readFileString(barrelPath, "utf8"),
    );
    if (!barrel.includes("import './moltzap.js';")) {
      yield* fsEffect(
        `write nanoclaw channel barrel ${barrelPath}`,
        fileSystem.writeFileString(
          barrelPath,
          barrel.trimEnd() + "\n\nimport './moltzap.js';\n",
        ),
      );
    }

    // Copy the shared root SKILL.md into nanoclaw's container/skills tree
    // (container/skills/ is what nanoclaw's agent container mounts, NOT
    // .claude/skills/ which is the host-side dev tree).
    const skillMdSrc = resolveSkillMdPath();
    const skillMdExists = yield* fsEffect(
      `check shared SKILL.md ${skillMdSrc}`,
      fileSystem.exists(skillMdSrc),
    );
    if (!skillMdExists) {
      return yield* Effect.fail(
        toRuntimeError(
          `Expected shared SKILL.md at ${skillMdSrc} — repo layout change?`,
        ),
      );
    }
    yield* fsEffect(
      "create nanoclaw moltzap skill directory",
      fileSystem.makeDirectory(
        pathSync((path) => path.join(tmpDir, "container/skills/moltzap")),
        {
          recursive: true,
        },
      ),
    );
    yield* fsEffect(
      `copy shared SKILL.md into nanoclaw cache ${skillMdSrc}`,
      fileSystem.copyFile(
        skillMdSrc,
        pathSync((path) =>
          path.join(tmpDir, "container/skills/moltzap/SKILL.md"),
        ),
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
    yield* fsEffect(
      `remove stale nanoclaw cache ${NANOCLAW_RUNTIME_CACHE}`,
      fileSystem.remove(NANOCLAW_RUNTIME_CACHE, {
        recursive: true,
        force: true,
      }),
    );
    yield* fsEffect(
      "create nanoclaw cache parent directory",
      fileSystem.makeDirectory(
        pathSync((path) => path.dirname(NANOCLAW_RUNTIME_CACHE)),
        {
          recursive: true,
        },
      ),
    );
    yield* fsEffect(
      "promote nanoclaw temp cache into ready cache",
      fileSystem.rename(tmpDir, NANOCLAW_RUNTIME_CACHE),
    );
    yield* fsEffect(
      `write nanoclaw ready marker ${readyMarker}`,
      fileSystem.writeFileString(readyMarker, ""),
    );
  }).pipe(Effect.withSpan("ensureNanoclawRuntimeInstalledEffect"));
}

export function startNanoclawRuntimeEffect(
  opts: StartNanoclawRuntimeOptions,
): Effect.Effect<
  NanoclawRuntimeHandle,
  NanoclawRuntimeProcessError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dataDir = yield* fsEffect(
      "create nanoclaw runtime data dir",
      fileSystem.makeTempDirectory({
        prefix: "moltzap-nanoclaw-runtime-",
      }),
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
      const workspaceRoot = pathSync((path) =>
        path.join(NANOCLAW_RUNTIME_CACHE, "container/skills"),
      );
      for (const file of opts.workspaceFiles) {
        const destination = pathSync((path) =>
          path.join(workspaceRoot, file.relativePath),
        );
        const destinationDir = pathSync((path) => path.dirname(destination));
        yield* fsEffect(
          `create workspace file directory ${destinationDir}`,
          fileSystem.makeDirectory(destinationDir, {
            recursive: true,
          }),
        );
        yield* fsEffect(
          `write workspace file ${destination}`,
          fileSystem.writeFileString(destination, file.content),
        );
      }
    }

    const capturedLogs: string[] = [];

    const command = Command.make("node", "dist/index.js").pipe(
      Command.workingDirectory(NANOCLAW_RUNTIME_CACHE),
      Command.env({
        MOLTZAP_API_KEY: opts.apiKey,
        MOLTZAP_SERVER_URL: normalizedServerUrl,
        MOLTZAP_EVAL_MODE: "1",
        DATA_DIR: dataDir,
        CONTAINER_RUNTIME: "docker",
        ONECLI_URL: ONECLI_URL,
        LOG_LEVEL: "info",
      }),
    );
    const { proc, scope, exitFiber } = yield* Effect.gen(function* () {
      const scope = yield* Scope.make();
      const proc = yield* Command.start(command).pipe(Scope.extend(scope));
      const exitFiber = yield* proc.exitCode.pipe(
        Effect.map(Number),
        Effect.catchAll(() => Effect.succeed(-1)),
        Effect.forkIn(scope),
      );
      yield* consumeProcessStream(proc.stdout, capturedLogs).pipe(
        Effect.forkIn(scope),
      );
      yield* consumeProcessStream(proc.stderr, capturedLogs).pipe(
        Effect.forkIn(scope),
      );
      return { proc, scope, exitFiber };
    }).pipe(
      Effect.provide(NodeContext.layer),
      Effect.mapError((cause) =>
        toRuntimeError("spawn nanoclaw runtime", cause),
      ),
    );

    const waitForMarker = Effect.iterate(false, {
      while: (connected) => !connected,
      body: () =>
        Effect.sleep(Duration.millis(CONNECT_WATCH_INTERVAL_MS)).pipe(
          Effect.as(CONNECTED_MARKER.test(capturedLogs.join(""))),
        ),
    }).pipe(Effect.asVoid);
    const exitBeforeConnect = Fiber.join(exitFiber).pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          toRuntimeError(
            `nanoclaw runtime exited before connecting (code=${code}).\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${logTail(capturedLogs)}`,
          ),
        ),
      ),
    );
    const waitForConnection = Effect.race(
      waitForMarker,
      exitBeforeConnect,
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(CONNECT_TIMEOUT_MS),
        onTimeout: () => {
          return toRuntimeError(
            `nanoclaw runtime did not connect within ${
              CONNECT_TIMEOUT_MS / MILLISECONDS_PER_SECOND
            }s.\nLast ${LOG_TAIL_LINE_COUNT} log lines:\n${logTail(capturedLogs)}`,
          );
        },
      }),
    );
    yield* waitForConnection;
    return { proc, scope, exitFiber, dataDir, capturedLogs };
  }).pipe(Effect.withSpan("startNanoclawRuntimeEffect"));
}

export function stopNanoclawRuntimeEffect(
  handle: NanoclawRuntimeHandle,
): Effect.Effect<void, NanoclawRuntimeProcessError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const isRunning = yield* handle.proc.isRunning.pipe(
      Effect.provide(NodeContext.layer),
      Effect.mapError((cause) =>
        toRuntimeError("check nanoclaw runtime process", cause),
      ),
    );
    if (isRunning) {
      const exited = yield* killProcessAndWait(
        handle.proc,
        "SIGTERM",
        GRACEFUL_STOP_MS,
      );
      const stillRunning = yield* handle.proc.isRunning.pipe(
        Effect.provide(NodeContext.layer),
        Effect.mapError((cause) =>
          toRuntimeError("check nanoclaw runtime process", cause),
        ),
      );
      if (!exited && stillRunning) {
        yield* killProcessAndWait(handle.proc, "SIGKILL", GRACEFUL_STOP_MS);
      }
    }
    yield* Scope.close(handle.scope, Exit.succeed(undefined));
    yield* fsEffect(
      `remove nanoclaw data dir ${handle.dataDir}`,
      fileSystem.remove(handle.dataDir, { recursive: true, force: true }),
    );
  }).pipe(Effect.withSpan("stopNanoclawRuntimeEffect"));
}

export function getNanoclawRuntimeLogs(handle: NanoclawRuntimeHandle): string {
  return handle.capturedLogs.join("");
}
