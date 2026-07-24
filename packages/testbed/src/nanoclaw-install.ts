import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Data, Duration, Effect, Option, Ref } from "effect";
import { makeCommandHelpers } from "./child-process.js";

// Shared root for the install cache and per-agent runtime dirs. Must stay
// under the user home: both hold docker bind-mount sources, and macOS
// VM-backed engines only share home paths by default.
export const MOLTZAP_TESTBED_CACHE_ROOT = join(
  homedir(),
  ".cache",
  "moltzap-testbed",
);

const NANOCLAW_SHA = "641963c1e4b7ba4f000a18dfc5e2fea29069feec";
const NANOCLAW_URL =
  "https://github.com/nanocoai/nanoclaw/archive/" + NANOCLAW_SHA + ".tar.gz";
const NANOCLAW_CACHE_SCHEMA_VERSION = 5;
const NANOCLAW_IMAGE_REPOSITORY = "nanoclaw-agent";
const NANOCLAW_IMAGE_TAG_PREFIX = "moltzap";
const BUILDING_CACHE_PREFIX = ".building-";
const CACHE_GENERATION_PREFIX = "generation-";
const INSTALL_PERMIT = Effect.runSync(Effect.makeSemaphore(1));

// A verified install is process-invariant (the fingerprint covers assets and
// host ABI), so spawns after the first skip the docker/filesystem
// re-verification. Only success is cached — a failed attempt retries fresh.
const WARM_INSTALL = Effect.runSync(
  Ref.make<NanoclawRuntimeInstall | null>(null),
);

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

function installError(reason: string, cause?: unknown) {
  return new NanoclawInstallError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { execEffect, fsEffect } = makeCommandHelpers(installError);

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256OfFile(filePath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "read file for sha256 " + filePath,
        fileSystem.readFile(filePath),
      ),
    ),
    Effect.map(sha256Hex),
  );
}

function bundledAssetPath(assetName: string): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "nanoclaw-assets",
    assetName,
  );
}

// Bundled assets and host ABI are process-constant, so the fingerprint is
// computed once and reused by every spawn.
const cachedCacheTarget = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const [channelHash, skillHash, packageJsonHash, packageLockHash] =
        yield* Effect.all(
          [
            sha256OfFile(bundledAssetPath("moltzap.ts")),
            sha256OfFile(bundledAssetPath("SKILL.md")),
            sha256OfFile(bundledAssetPath("package.json")),
            sha256OfFile(bundledAssetPath("package-lock.json")),
          ],
          { concurrency: 4 },
        );
      const cacheFingerprint = sha256Hex(
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
      );
      return {
        cacheRoot: join(
          MOLTZAP_TESTBED_CACHE_ROOT,
          "nanoclaw",
          cacheFingerprint,
        ),
        cacheFingerprint,
      };
    }),
  ),
);

function resolveCacheTarget() {
  return cachedCacheTarget;
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
    // The bundled manifest mirrors upstream's with two deliberate
    // divergences: @moltzap/{client,protocol} are added for the channel,
    // and better-sqlite3 rides the v12 line because upstream's exact 11.x
    // pin has no prebuilds for current host Node and its source no longer
    // compiles against modern V8.
    yield* copyBundledAsset("package.json", join(tmpDir, "package.json"));
    yield* copyBundledAsset(
      "package-lock.json",
      join(tmpDir, "package-lock.json"),
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

function buildContainerImage(install: NanoclawRuntimeInstall) {
  // Upstream's container/build.sh derives the image name from its own
  // checkout path; the testbed owns naming (one fingerprint-tagged image
  // shared by every per-agent runtime dir, selected via the CONTAINER_IMAGE
  // env override), so it drives `docker build` directly. A cold build pulls
  // the base image and apt/CLI layers — multi-minute single-layer steps the
  // hang guard must not trip on.
  return execEffect(
    'docker build -t "' + install.containerImage + '" container',
    { cwd: install.cacheDir, timeout: 900_000 },
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
    yield* buildContainerImage(install);
    yield* requireContainerImage(install.containerImage);
  });
}

// The npm leg (host deps, dist, upgrade marker) and the image leg share
// only the immutable container/ build context, so they run concurrently.
function buildRuntime(install: NanoclawRuntimeInstall) {
  return Effect.all(
    [
      execEffect("HUSKY=0 npm ci", {
        cwd: install.cacheDir,
        timeout: 300_000,
      }).pipe(
        Effect.andThen(
          execEffect("npm run build", {
            cwd: install.cacheDir,
            timeout: 120_000,
          }),
        ),
        Effect.andThen(stampUpgradeMarker(install.cacheDir)),
      ),
      buildContainerImage(install).pipe(
        Effect.andThen(requireContainerImage(install.containerImage)),
      ),
    ],
    { concurrency: 2, discard: true },
  );
}

// NanoClaw's startup tripwire requires data/upgrade-state.json to match the
// code version; stamping through upstream's own writer keeps the marker
// schema tracking upstream across SHA bumps.
function stampUpgradeMarker(sourceDir: string) {
  return execEffect(
    '"node_modules/.bin/tsx" scripts/upgrade-state.ts set "" moltzap-testbed',
    { cwd: sourceDir, timeout: 60_000 },
  );
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
      yield* buildRuntime(buildingInstall);
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
  return Effect.gen(function* () {
    const warm = yield* Ref.get(WARM_INSTALL);
    if (warm !== null) return warm;
    const install = yield* INSTALL_PERMIT.withPermits(1)(
      verifyOrBuildInstall(),
    );
    yield* Ref.set(WARM_INSTALL, install);
    return install;
  }).pipe(Effect.withSpan("ensureNanoclawRuntimeInstalledEffect"));
}

function verifyOrBuildInstall() {
  return Effect.gen(function* () {
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
  });
}
