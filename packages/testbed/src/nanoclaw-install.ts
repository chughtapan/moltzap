import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Data, Duration, Effect, Option } from "effect";

const NANOCLAW_SHA = "934f063aff5c30e7b49ce58b53b41901d3472a3e";
const NANOCLAW_URL =
  "https://github.com/qwibitai/nanoclaw/archive/" + NANOCLAW_SHA + ".tar.gz";
const NANOCLAW_CACHE_SCHEMA_VERSION = 3;
const NANOCLAW_IMAGE_REPOSITORY = "nanoclaw-agent";
const NANOCLAW_IMAGE_TAG_PREFIX = "moltzap";
const BUILDING_CACHE_PREFIX = ".building-";
const CACHE_GENERATION_PREFIX = "generation-";
const SHA_256 = "SHA-256";
const HEX_RADIX = 16;
const HEX_BYTE_PAD = 2;
const UTF8_ENCODER = new TextEncoder();
const INSTALL_PERMIT = Effect.runSync(Effect.makeSemaphore(1));

export interface NanoclawRuntimeInstall {
  readonly cacheDir: string;
  readonly cacheFingerprint: string;
  readonly containerImage: string;
}

interface NanoclawCacheTarget {
  readonly cacheRoot: string;
  readonly cacheFingerprint: string;
}

class NanoclawInstallError extends Data.TaggedError("NanoclawInstallError")<{
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

function installError(reason: string, cause?: unknown) {
  return new NanoclawInstallError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

function fsEffect<A>(reason: string, effect: Effect.Effect<A, PlatformError>) {
  return effect.pipe(Effect.mapError((cause) => installError(reason, cause)));
}

function execEffect(commandText: string, options?: CommandRunOptions) {
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
              installError(
                "command timed out after " +
                  options.timeout +
                  "ms: " +
                  commandText,
              ),
          }),
        );
  return exitCode.pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : Effect.fail(
            installError(
              "command failed with exit code " + code + ": " + commandText,
            ),
          ),
    ),
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof NanoclawInstallError
        ? cause
        : installError("command failed: " + commandText, cause),
    ),
  );
}

function sha256(data: Uint8Array) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return Effect.fail(installError("Runtime crypto.subtle is not available"));
  }
  return Effect.tryPromise({
    try: () => subtle.digest(SHA_256, new Uint8Array(data)),
    catch: (cause) => installError("sha256 digest failed", cause),
  }).pipe(Effect.map(hexDigest));
}

function hexDigest(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_PAD, "0"))
    .join("");
}

function sha256OfFile(filePath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "read file for sha256 " + filePath,
        fileSystem.readFile(filePath),
      ),
    ),
    Effect.flatMap(sha256),
  );
}

function bundledAssetPath(assetName: string): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "nanoclaw-assets",
    assetName,
  );
}

function resolveCacheTarget() {
  return Effect.gen(function* () {
    const [channelHash, skillHash, packageJsonHash, packageLockHash] =
      yield* Effect.all([
        sha256OfFile(bundledAssetPath("moltzap.ts")),
        sha256OfFile(bundledAssetPath("SKILL.md")),
        sha256OfFile(bundledAssetPath("package.json")),
        sha256OfFile(bundledAssetPath("package-lock.json")),
      ]);
    const cacheFingerprint = yield* sha256(
      UTF8_ENCODER.encode(
        JSON.stringify({
          cacheSchema: NANOCLAW_CACHE_SCHEMA_VERSION,
          nanoclawSha: NANOCLAW_SHA,
          channelHash,
          skillHash,
          packageJsonHash,
          packageLockHash,
          platform: process.platform,
          architecture: process.arch,
          nodeAbi: process.versions.modules,
        }),
      ),
    );
    return {
      cacheRoot: join(
        homedir(),
        ".cache/moltzap-testbed/nanoclaw",
        cacheFingerprint,
      ),
      cacheFingerprint,
    };
  });
}

function runtimeInstall(
  cacheDir: string,
  cacheFingerprint: string,
): NanoclawRuntimeInstall {
  return {
    cacheDir,
    cacheFingerprint,
    containerImage:
      NANOCLAW_IMAGE_REPOSITORY + ":" + containerImageTag(cacheFingerprint),
  };
}

function containerImageTag(cacheFingerprint: string): string {
  return NANOCLAW_IMAGE_TAG_PREFIX + "-" + cacheFingerprint;
}

function readyMarkerPath(cacheDir: string): string {
  return join(cacheDir, ".ready");
}

function readReadyFingerprint(readyMarker: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fsEffect(
      "check nanoclaw ready marker " + readyMarker,
      fileSystem.exists(readyMarker),
    );
    if (!exists) return null;
    return yield* fileSystem
      .readFileString(readyMarker, "utf8")
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logDebug(
            "ignoring unreadable NanoClaw ready marker",
            cause,
          ).pipe(Effect.as(null)),
        ),
      );
  });
}

function createBuildingCache(cacheRoot: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fsEffect(
      "create nanoclaw cache root " + cacheRoot,
      fileSystem.makeDirectory(cacheRoot, { recursive: true }),
    );
    return yield* fsEffect(
      "create unique nanoclaw building cache",
      fileSystem.makeTempDirectory({
        directory: cacheRoot,
        prefix: BUILDING_CACHE_PREFIX,
      }),
    );
  });
}

function removeBuildingCacheBestEffort(buildingDir: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.remove(buildingDir, { recursive: true, force: true }),
    ),
    Effect.catchAll((cause) =>
      Effect.logWarning("failed to remove NanoClaw building cache", cause),
    ),
  );
}

// Building dirs from hard-killed installers (SIGKILL skips the ensuring
// cleanup) would otherwise accumulate full checkouts forever. The age gate
// keeps the sweep from deleting a concurrent process's in-progress build.
const STALE_BUILDING_CACHE_MAX_AGE_MS = 86_400_000;

/** @internal */
export function sweepStaleBuildingCaches(
  cacheRoot: string,
  maxAgeMs: number = STALE_BUILDING_CACHE_MAX_AGE_MS,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(cacheRoot);
    if (!exists) return;
    const entries = yield* fileSystem.readDirectory(cacheRoot);
    const cutoff = Date.now() - maxAgeMs;
    const buildingDirs = entries
      .filter((entry) => entry.startsWith(BUILDING_CACHE_PREFIX))
      .map((entry) => join(cacheRoot, entry));
    for (const buildingDir of buildingDirs) {
      const info = yield* fileSystem.stat(buildingDir);
      const mtime = Option.getOrNull(info.mtime);
      if (mtime !== null && mtime.getTime() <= cutoff) {
        yield* fileSystem.remove(buildingDir, { recursive: true, force: true });
      }
    }
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(
        "failed to sweep stale NanoClaw building caches",
        cause,
      ),
    ),
    Effect.withSpan("sweepStaleBuildingCaches"),
  );
}

function ensureBundledAssetExists(assetPath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fsEffect(
      "check bundled nanoclaw asset " + assetPath,
      fileSystem.exists(assetPath),
    );
    if (!exists) {
      return yield* Effect.fail(
        installError(
          "Expected bundled NanoClaw asset at " +
            assetPath +
            "; rebuild @moltzap/testbed",
        ),
      );
    }
  });
}

function copyBundledAsset(assetName: string, destination: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = bundledAssetPath(assetName);
    yield* ensureBundledAssetExists(source);
    yield* fsEffect(
      "copy bundled NanoClaw asset " + assetName,
      fileSystem.copyFile(source, destination),
    );
  });
}

function injectBundledAssets(tmpDir: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* copyBundledAsset(
      "moltzap.ts",
      join(tmpDir, "src/channels/moltzap.ts"),
    );

    const barrelPath = join(tmpDir, "src/channels/index.ts");
    const barrel = yield* fsEffect(
      "read nanoclaw channel barrel " + barrelPath,
      fileSystem.readFileString(barrelPath, "utf8"),
    );
    if (!barrel.includes("import './moltzap.js';")) {
      yield* fsEffect(
        "write nanoclaw channel barrel " + barrelPath,
        fileSystem.writeFileString(
          barrelPath,
          barrel.trimEnd() + "\n\nimport './moltzap.js';\n",
        ),
      );
    }

    const skillDir = join(tmpDir, "container/skills/moltzap");
    yield* fsEffect(
      "create nanoclaw moltzap skill directory",
      fileSystem.makeDirectory(skillDir, { recursive: true }),
    );
    yield* copyBundledAsset("SKILL.md", join(skillDir, "SKILL.md"));
    yield* copyBundledAsset("package.json", join(tmpDir, "package.json"));
    yield* copyBundledAsset(
      "package-lock.json",
      join(tmpDir, "package-lock.json"),
    );
  });
}

function replacePinnedSource(
  source: string,
  expected: string,
  replacement: string,
  fileName: string,
) {
  const index = source.indexOf(expected);
  if (index < 0 || index !== source.lastIndexOf(expected)) {
    return Effect.fail(
      installError(
        "Pinned NanoClaw " +
          fileName +
          " no longer matches its isolation patch anchor",
      ),
    );
  }
  return Effect.succeed(
    source.slice(0, index) +
      replacement +
      source.slice(index + expected.length),
  );
}

export function patchNanoclawContainerIsolationSources(
  containerRuntimeSource: string,
  containerRunnerSource: string,
) {
  return Effect.gen(function* () {
    const runtimeWithNamespace = yield* replacePinnedSource(
      containerRuntimeSource,
      "export const CONTAINER_RUNTIME_BIN = 'docker';",
      [
        "export const CONTAINER_RUNTIME_BIN = 'docker';",
        "",
        "const containerNamespace = (",
        "  process.env.NANOCLAW_RUNTIME_NAMESPACE || 'default'",
        ").replace(/[^a-zA-Z0-9_.-]/g, '-');",
        "export const CONTAINER_NAME_PREFIX =",
        "  'nanoclaw-' + containerNamespace + '-';",
      ].join("\n"),
      "src/container-runtime.ts",
    );
    // The "$" + "{...}" concatenations below emit literal template-placeholder
    // text into the patched NanoClaw sources; writing "${...}" directly here
    // would trip no-template-curly-in-string and read as an intended
    // interpolation of this file.
    const patchedRuntime = yield* replacePinnedSource(
      runtimeWithNamespace,
      "name=nanoclaw-",
      "name=" + "$" + "{CONTAINER_NAME_PREFIX}",
      "src/container-runtime.ts",
    );
    const runnerWithImport = yield* replacePinnedSource(
      containerRunnerSource,
      "  CONTAINER_RUNTIME_BIN,\n  hostGatewayArgs,",
      "  CONTAINER_NAME_PREFIX,\n  CONTAINER_RUNTIME_BIN,\n  hostGatewayArgs,",
      "src/container-runner.ts",
    );
    const patchedRunner = yield* replacePinnedSource(
      runnerWithImport,
      "nanoclaw-" + "$" + "{safeName}-",
      "$" + "{CONTAINER_NAME_PREFIX}" + "$" + "{safeName}-",
      "src/container-runner.ts",
    );
    return {
      containerRuntimeSource: patchedRuntime,
      containerRunnerSource: patchedRunner,
    };
  }).pipe(Effect.withSpan("patchNanoclawContainerIsolationSources"));
}

function patchContainerIsolation(tmpDir: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const containerRuntimePath = join(tmpDir, "src/container-runtime.ts");
    const containerRunnerPath = join(tmpDir, "src/container-runner.ts");
    const [containerRuntimeSource, containerRunnerSource] = yield* Effect.all([
      fsEffect(
        "read pinned NanoClaw source " + containerRuntimePath,
        fileSystem.readFileString(containerRuntimePath, "utf8"),
      ),
      fsEffect(
        "read pinned NanoClaw source " + containerRunnerPath,
        fileSystem.readFileString(containerRunnerPath, "utf8"),
      ),
    ]);
    const patched = yield* patchNanoclawContainerIsolationSources(
      containerRuntimeSource,
      containerRunnerSource,
    );
    yield* fsEffect(
      "patch NanoClaw container isolation " + containerRuntimePath,
      fileSystem.writeFileString(
        containerRuntimePath,
        patched.containerRuntimeSource,
      ),
    );
    yield* fsEffect(
      "patch NanoClaw container isolation " + containerRunnerPath,
      fileSystem.writeFileString(
        containerRunnerPath,
        patched.containerRunnerSource,
      ),
    );
  });
}

function downloadPinnedSource(destDir: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fsEffect(
      "create nanoclaw download directory " + destDir,
      fileSystem.makeDirectory(destDir, { recursive: true }),
    );
    const tarballPath = join(destDir, "nanoclaw.tar.gz");
    yield* execEffect(
      'curl -fsSL "' + NANOCLAW_URL + '" -o "' + tarballPath + '"',
      { timeout: 60_000 },
    );
    yield* execEffect(
      'tar -xzf "' +
        tarballPath +
        '" -C "' +
        destDir +
        '" --strip-components=1',
      { timeout: 30_000 },
    );
    yield* fsEffect(
      "remove downloaded nanoclaw tarball " + tarballPath,
      fileSystem.remove(tarballPath),
    );
  });
}

function preflightDocker() {
  return execEffect("docker info", { timeout: 5_000 }).pipe(
    Effect.mapError((cause) =>
      installError(
        "NanoClaw requires Docker on the host. docker info failed: " +
          cause.message,
        cause,
      ),
    ),
  );
}

function dockerImageExists(containerImage: string) {
  return Command.exitCode(
    Command.make("docker", "image", "inspect", containerImage),
  ).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(10),
      onTimeout: () =>
        installError(
          "timed out checking NanoClaw container image " + containerImage,
        ),
    }),
    Effect.map((code) => Number(code) === 0),
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof NanoclawInstallError
        ? cause
        : installError(
            "check NanoClaw container image " + containerImage,
            cause,
          ),
    ),
  );
}

function buildContainerImage(
  sourceDir: string,
  install: NanoclawRuntimeInstall,
) {
  return execEffect(
    'bash container/build.sh "' +
      containerImageTag(install.cacheFingerprint) +
      '"',
    { cwd: sourceDir, timeout: 300_000 },
  );
}

function requireContainerImage(containerImage: string) {
  return dockerImageExists(containerImage).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.void
        : Effect.fail(
            installError(
              "NanoClaw container build did not create " + containerImage,
            ),
          ),
    ),
  );
}

function ensureContainerImage(install: NanoclawRuntimeInstall) {
  return Effect.gen(function* () {
    if (yield* dockerImageExists(install.containerImage)) return;
    yield* buildContainerImage(install.cacheDir, install);
    yield* requireContainerImage(install.containerImage);
  });
}

function buildRuntime(tmpDir: string, install: NanoclawRuntimeInstall) {
  return Effect.gen(function* () {
    yield* execEffect("HUSKY=0 npm ci", {
      cwd: tmpDir,
      timeout: 300_000,
    });
    yield* execEffect("npm run build", { cwd: tmpDir, timeout: 120_000 });
    yield* buildContainerImage(tmpDir, install);
    yield* requireContainerImage(install.containerImage);
  });
}

function writeReadyMarker(tmpDir: string, cacheFingerprint: string) {
  const readyMarker = readyMarkerPath(tmpDir);
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "write nanoclaw ready marker " + readyMarker,
        fileSystem.writeFileString(readyMarker, cacheFingerprint),
      ),
    ),
  );
}

/**
 * Finds an immutable generation whose ready marker matches the full cache
 * fingerprint. Partial builds and corrupt generations are never selected.
 * @internal
 */
export function findNanoclawCacheGeneration(
  cacheRoot: string,
  cacheFingerprint: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fsEffect(
      "check nanoclaw cache root " + cacheRoot,
      fileSystem.exists(cacheRoot),
    );
    if (!exists) return null;
    const entries = yield* fsEffect(
      "list nanoclaw cache generations " + cacheRoot,
      fileSystem.readDirectory(cacheRoot),
    );
    for (const entry of entries.filter(isCacheGeneration).sort()) {
      const generationDir = join(cacheRoot, entry);
      const readyFingerprint = yield* readReadyFingerprint(
        readyMarkerPath(generationDir),
      );
      if (readyFingerprint === cacheFingerprint) return generationDir;
    }
    return null;
  }).pipe(Effect.withSpan("findNanoclawCacheGeneration"));
}

function isCacheGeneration(entry: string): boolean {
  return entry.startsWith(CACHE_GENERATION_PREFIX);
}

/**
 * Publishes a completed build under a unique immutable generation name.
 * @internal
 */
export function publishNanoclawCacheGeneration(
  buildingDir: string,
  cacheRoot: string,
) {
  const generationDir = join(
    cacheRoot,
    CACHE_GENERATION_PREFIX +
      basename(buildingDir).slice(BUILDING_CACHE_PREFIX.length),
  );
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "publish nanoclaw cache generation " + generationDir,
        fileSystem.rename(buildingDir, generationDir),
      ),
    ),
    Effect.as(generationDir),
    Effect.withSpan("publishNanoclawCacheGeneration"),
  );
}

function buildAndPublish(target: NanoclawCacheTarget) {
  return Effect.gen(function* () {
    const buildingDir = yield* createBuildingCache(target.cacheRoot);
    return yield* Effect.gen(function* () {
      const buildingInstall = runtimeInstall(
        buildingDir,
        target.cacheFingerprint,
      );
      yield* downloadPinnedSource(buildingDir);
      yield* injectBundledAssets(buildingDir);
      yield* patchContainerIsolation(buildingDir);
      yield* buildRuntime(buildingDir, buildingInstall);
      yield* writeReadyMarker(buildingDir, target.cacheFingerprint);
      const generationDir = yield* publishNanoclawCacheGeneration(
        buildingDir,
        target.cacheRoot,
      );
      return runtimeInstall(generationDir, target.cacheFingerprint);
    }).pipe(Effect.ensuring(removeBuildingCacheBestEffort(buildingDir)));
  });
}

export function ensureNanoclawRuntimeInstalledEffect() {
  return INSTALL_PERMIT.withPermits(1)(
    Effect.gen(function* () {
      const target = yield* resolveCacheTarget();
      yield* sweepStaleBuildingCaches(target.cacheRoot);
      yield* preflightDocker();
      const generationDir = yield* findNanoclawCacheGeneration(
        target.cacheRoot,
        target.cacheFingerprint,
      );
      if (generationDir === null) return yield* buildAndPublish(target);
      const install = runtimeInstall(generationDir, target.cacheFingerprint);
      yield* ensureContainerImage(install);
      return install;
    }),
  ).pipe(Effect.withSpan("ensureNanoclawRuntimeInstalledEffect"));
}
