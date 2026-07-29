/** @file Immutable NanoClaw installation acquisition. */

import { createHash } from "node:crypto";
import { basename, join, posix } from "node:path";
import { Command, FileSystem } from "@effect/platform";
import { Data, Duration, Effect } from "effect";
import { makeCommandHelpers } from "../command.js";
import {
  cacheFingerprint,
  CACHE_BUILD_PERMIT,
  makeJsonGuards,
  makeImmutableCache,
  makeSuccessMemo,
  MOLTZAP_SIMULATOR_CACHE_ROOT,
} from "../cache.js";
import {
  findWorkspacePackagesDir,
  resolveOwningPackageRoot,
  type InstallMode,
} from "../packages.js";

/** Pinned NanoClaw source revision; the simulator's manifest cites it as the runtime version. */
const NANOCLAW_SHA = "641963c1e4b7ba4f000a18dfc5e2fea29069feec";
const NANOCLAW_URL =
  "https://github.com/nanocoai/nanoclaw/archive/" + NANOCLAW_SHA + ".tar.gz";
const NANOCLAW_CACHE_SCHEMA_VERSION = 5;
const NANOCLAW_IMAGE_REPOSITORY = "nanoclaw-agent";
const NANOCLAW_IMAGE_TAG_PREFIX = "moltzap";
const CLIENT_PACKAGE_NAME = "@moltzap/client";
const PROTOCOL_PACKAGE_NAME = "@moltzap/protocol";
const WORKSPACE_VENDOR_DIRECTORY = "vendor";
const WORKSPACE_DIST_ENTRY = join("dist", "index.js");
const WORKSPACE_PACK_TIMEOUT_MS = 120_000;
const WORKSPACE_LOCK_TIMEOUT_MS = 120_000;
const TARBALL_EXTENSION = ".tgz";
const SHA512_INTEGRITY_PREFIX = "sha512-";
const JSON_INDENT_SPACES = 2;
const REGISTRY_MOLTZAP_PATTERN = /registry\.npmjs\.org\/@moltzap(?:\/|%2f)/i;
const SIMULATOR_PACKAGE_NAME = "@moltzap/simulator";
const NANOCLAW_ASSETS_DIRECTORY = join(
  resolveOwningPackageRoot(SIMULATOR_PACKAGE_NAME, import.meta.url),
  "dist",
  "nanoclaw-assets",
);

// A verified install is process-invariant for one mode, so later spawns reuse
// it without repeating filesystem and Docker verification. The map changes
// only after verification succeeds; failure and interruption leave no state.
const WARM_INSTALLS = Effect.runSync(
  makeSuccessMemo<InstallMode, NanoclawRuntimeInstall>(),
);

export interface NanoclawRuntimeInstall {
  readonly cacheDir: string;
  readonly cacheFingerprint: string;
  readonly containerImage: string;
}

interface BaseNanoclawCacheTarget {
  readonly cacheRoot: string;
  readonly cacheFingerprint: string;
}

interface PublishedNanoclawCacheTarget extends BaseNanoclawCacheTarget {
  readonly installMode: "published";
}

interface WorkspaceNanoclawCacheTarget extends BaseNanoclawCacheTarget {
  readonly installMode: "workspace";
  readonly workspaceDependencies: NanoclawWorkspaceDependencies;
}

type NanoclawCacheTarget =
  | PublishedNanoclawCacheTarget
  | WorkspaceNanoclawCacheTarget;

interface NanoclawFingerprintInput {
  readonly channelHash: string;
  readonly evalProvisionHash: string;
  readonly skillHash: string;
  readonly packageJsonHash: string;
  readonly packageLockHash: string;
  readonly platform: string;
  readonly architecture: string;
  readonly nodeAbi: string;
}

export interface NanoclawWorkspaceTarball {
  readonly packageName: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly tarballFileName: string;
  readonly sha256: string;
  readonly integrity: string;
}

export interface NanoclawWorkspaceDependencies {
  readonly client: NanoclawWorkspaceTarball;
  readonly protocol: NanoclawWorkspaceTarball;
}

interface WorkspacePackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, unknown>>;
}

interface PreparedWorkspaceTarball {
  readonly manifest: WorkspacePackageManifest;
  readonly tarball: NanoclawWorkspaceTarball;
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

const { commandOutputEffect, execEffect, fsEffect } =
  makeCommandHelpers(installError);
const { requireExactValue, requireRecord, requireSoleEntry, requireString } =
  makeJsonGuards(installError);

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha512Integrity(data: Uint8Array): string {
  return (
    SHA512_INTEGRITY_PREFIX + createHash("sha512").update(data).digest("base64")
  );
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
  return join(NANOCLAW_ASSETS_DIRECTORY, assetName);
}

// A cold acquisition hashes the package-owned assets directly. A verified
// warm install bypasses this work entirely.
function nanoclawFingerprintInput() {
  return Effect.gen(function* () {
    const [
      channelHash,
      evalProvisionHash,
      skillHash,
      packageJsonHash,
      packageLockHash,
    ] = yield* Effect.all(
      [
        sha256OfFile(bundledAssetPath("moltzap.ts")),
        sha256OfFile(bundledAssetPath("moltzap-eval-provision.ts")),
        sha256OfFile(bundledAssetPath("SKILL.md")),
        sha256OfFile(bundledAssetPath("package.json")),
        sha256OfFile(bundledAssetPath("package-lock.json")),
      ],
      { concurrency: 5 },
    );
    return {
      channelHash,
      evalProvisionHash,
      skillHash,
      packageJsonHash,
      packageLockHash,
      platform: process.platform,
      architecture: process.arch,
      nodeAbi: process.versions.modules,
    } satisfies NanoclawFingerprintInput;
  });
}

/** @internal */
export function nanoclawCacheFingerprint(
  input: NanoclawFingerprintInput,
  workspaceHashes?: {
    readonly clientTarballHash: string;
    readonly protocolTarballHash: string;
  },
): string {
  return cacheFingerprint(NANOCLAW_CACHE_SCHEMA_VERSION, {
    nanoclawSha: NANOCLAW_SHA,
    channelHash: input.channelHash,
    evalProvisionHash: input.evalProvisionHash,
    skillHash: input.skillHash,
    packageJsonHash: input.packageJsonHash,
    packageLockHash: input.packageLockHash,
    platform: input.platform,
    architecture: input.architecture,
    nodeAbi: input.nodeAbi,
    ...(workspaceHashes === undefined ? {} : workspaceHashes),
  });
}

function nanoclawCacheRoot(cacheFingerprint: string): string {
  return join(MOLTZAP_SIMULATOR_CACHE_ROOT, "nanoclaw", cacheFingerprint);
}

function resolvePublishedCacheTarget() {
  return nanoclawFingerprintInput().pipe(
    Effect.map((input) => {
      const fingerprint = nanoclawCacheFingerprint(input);
      return {
        installMode: "published",
        cacheRoot: nanoclawCacheRoot(fingerprint),
        cacheFingerprint: fingerprint,
      } satisfies PublishedNanoclawCacheTarget;
    }),
  );
}

function resolveWorkspaceCacheTarget() {
  return Effect.gen(function* () {
    const input = yield* nanoclawFingerprintInput();
    const workspaceDependencies = yield* prepareNanoclawWorkspaceDependencies();
    const fingerprint = nanoclawCacheFingerprint(input, {
      clientTarballHash: workspaceDependencies.client.sha256,
      protocolTarballHash: workspaceDependencies.protocol.sha256,
    });
    return {
      installMode: "workspace",
      cacheRoot: nanoclawCacheRoot(fingerprint),
      cacheFingerprint: fingerprint,
      workspaceDependencies,
    } satisfies WorkspaceNanoclawCacheTarget;
  });
}

function resolveCacheTarget(installMode: InstallMode) {
  return installMode === "published"
    ? resolvePublishedCacheTarget()
    : resolveWorkspaceCacheTarget();
}

function prepareNanoclawWorkspaceDependencies() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const packagesDir = findWorkspacePackagesDir(import.meta.url);
    if (packagesDir === null) {
      return yield* Effect.fail(
        installError(
          "Workspace install mode requires a MoltZap source checkout with packages/client and packages/protocol",
        ),
      );
    }
    // The target consumes both tarballs before this acquisition scope closes.
    const packRoot = yield* Effect.acquireRelease(
      fsEffect(
        "create temporary NanoClaw workspace pack directory",
        fileSystem.makeTempDirectory({
          prefix: "moltzap-nanoclaw-workspace-",
        }),
      ),
      (directory) =>
        fileSystem
          .remove(directory, { recursive: true, force: true })
          .pipe(Effect.catchAll(() => Effect.void)),
    );
    const [client, protocol] = yield* Effect.all(
      [
        packWorkspacePackage(
          join(packagesDir, "client"),
          CLIENT_PACKAGE_NAME,
          packRoot,
        ),
        packWorkspacePackage(
          join(packagesDir, "protocol"),
          PROTOCOL_PACKAGE_NAME,
          packRoot,
        ),
      ],
      { concurrency: 2 },
    );
    yield* assertPackedWorkspaceVersions({
      clientManifest: client.manifest,
      protocolManifest: protocol.manifest,
      clientVersion: client.tarball.version,
      protocolVersion: protocol.tarball.version,
    });
    return {
      client: client.tarball,
      protocol: protocol.tarball,
    } satisfies NanoclawWorkspaceDependencies;
  });
}

function packWorkspacePackage(
  packageDir: string,
  packageName: string,
  packRoot: string,
) {
  return Effect.gen(function* () {
    const sourceManifest = yield* readWorkspacePackageManifest(
      join(packageDir, "package.json"),
      packageName,
    );
    yield* requireBuiltWorkspacePackage(packageDir, packageName);
    const tarballPath = yield* createWorkspaceTarball(
      packageDir,
      packageName,
      packRoot,
    );
    const manifest = yield* readPackedWorkspaceManifest(
      tarballPath,
      packageName,
    );
    if (manifest.version !== sourceManifest.version) {
      return yield* Effect.fail(
        installError(
          `Packed ${packageName} version ${manifest.version} does not match workspace version ${sourceManifest.version}`,
        ),
      );
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fsEffect(
      `read packed workspace dependency ${tarballPath}`,
      fileSystem.readFile(tarballPath),
    );
    return {
      manifest,
      tarball: {
        packageName,
        version: manifest.version,
        tarballPath,
        tarballFileName: basename(tarballPath),
        sha256: sha256Hex(bytes),
        integrity: sha512Integrity(bytes),
      },
    } satisfies PreparedWorkspaceTarball;
  });
}

function requireBuiltWorkspacePackage(packageDir: string, packageName: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const distEntry = join(packageDir, WORKSPACE_DIST_ENTRY);
    const exists = yield* fsEffect(
      `check built workspace dependency ${distEntry}`,
      fileSystem.exists(distEntry),
    );
    if (!exists) {
      return yield* Effect.fail(
        installError(
          `Build ${packageName} before using NanoClaw workspace install mode; expected ${distEntry}`,
        ),
      );
    }
  });
}

function createWorkspaceTarball(
  packageDir: string,
  packageName: string,
  packRoot: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const outputDir = join(packRoot, basename(packageDir));
    yield* fsEffect(
      `create ${packageName} pack output directory`,
      fileSystem.makeDirectory(outputDir, { recursive: true }),
    );
    const command = Command.make(
      "pnpm",
      "pack",
      "--pack-destination",
      outputDir,
    ).pipe(Command.workingDirectory(packageDir));
    yield* commandOutputEffect(
      `pack workspace package ${packageName}`,
      command,
      {
        timeout: WORKSPACE_PACK_TIMEOUT_MS,
      },
    );
    const entries = (yield* fsEffect(
      `list packed workspace package ${packageName}`,
      fileSystem.readDirectory(outputDir),
    )).filter((entry) => entry.endsWith(TARBALL_EXTENSION));
    const entry = yield* requireSoleEntry(
      entries,
      `packed tarball for ${packageName}`,
    );
    return join(outputDir, entry);
  });
}

function readPackedWorkspaceManifest(tarballPath: string, packageName: string) {
  return commandOutputEffect(
    `read packed ${packageName} manifest`,
    Command.make("tar", "-xOf", tarballPath, "package/package.json"),
    { timeout: WORKSPACE_PACK_TIMEOUT_MS },
  ).pipe(
    Effect.flatMap((output) =>
      decodeWorkspacePackageManifest(output.stdout, packageName),
    ),
  );
}

function readWorkspacePackageManifest(
  manifestPath: string,
  packageName: string,
) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        `read workspace package manifest ${manifestPath}`,
        fileSystem.readFileString(manifestPath, "utf8"),
      ),
    ),
    Effect.flatMap((contents) =>
      decodeWorkspacePackageManifest(contents, packageName),
    ),
  );
}

function decodeWorkspacePackageManifest(contents: string, packageName: string) {
  return Effect.try({
    try: () => {
      const value: unknown = JSON.parse(contents);
      const manifest = requireRecord(value, `${packageName} package.json`);
      const name = requireString(manifest.name, `${packageName} name`);
      const version = requireString(manifest.version, `${packageName} version`);
      if (name !== packageName) {
        throw installError(
          `Expected packed workspace package ${packageName}; found ${name}`,
        );
      }
      return {
        name,
        version,
        dependencies: optionalRecord(
          manifest.dependencies,
          `${packageName} dependencies`,
        ),
      } satisfies WorkspacePackageManifest;
    },
    catch: (cause) =>
      cause instanceof NanoclawInstallError
        ? cause
        : installError(`Unable to decode ${packageName} package.json`, cause),
  });
}

/** @internal */
export function assertPackedWorkspaceVersions(input: {
  readonly clientManifest: WorkspacePackageManifest;
  readonly protocolManifest: WorkspacePackageManifest;
  readonly clientVersion: string;
  readonly protocolVersion: string;
}) {
  return Effect.try({
    try: () => {
      requireExactValue(
        input.clientManifest.name,
        CLIENT_PACKAGE_NAME,
        "packed client name",
      );
      requireExactValue(
        input.protocolManifest.name,
        PROTOCOL_PACKAGE_NAME,
        "packed protocol name",
      );
      requireExactValue(
        input.clientManifest.version,
        input.clientVersion,
        "packed client version",
      );
      requireExactValue(
        input.protocolManifest.version,
        input.protocolVersion,
        "packed protocol version",
      );
      requireExactValue(
        input.clientManifest.dependencies[PROTOCOL_PACKAGE_NAME],
        input.protocolManifest.version,
        "packed client protocol dependency",
      );
    },
    catch: (cause) =>
      cause instanceof NanoclawInstallError
        ? cause
        : installError(
            "Unable to validate packed NanoClaw workspace versions",
            cause,
          ),
  });
}

/**
 * Resolves a ready generation without building so integration probes can
 * guarantee they exercise the warm install path.
 * @internal
 */
export function findWarmNanoclawRuntimeInstallEffect(installMode: InstallMode) {
  return Effect.scoped(
    Effect.gen(function* () {
      const warm = yield* warmNanoclawInstall(installMode);
      if (warm !== null) return warm;
      const target = yield* resolveCacheTarget(installMode);
      const generationDir = yield* nanoclawInstallCache(
        target.cacheRoot,
      ).findCacheGeneration(target.cacheFingerprint);
      return generationDir === null
        ? null
        : runtimeInstall(generationDir, target.cacheFingerprint);
    }),
  ).pipe(Effect.withSpan("findWarmNanoclawRuntimeInstallEffect"));
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

/**
 * Binds the immutable cache lifecycle to this installer's error channel for
 * one cache root.
 * @internal
 */
export function nanoclawInstallCache(cacheRoot: string) {
  return makeImmutableCache(cacheRoot, installError);
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
            "; rebuild @moltzap/simulator",
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
    yield* copyBundledAsset(
      "moltzap-eval-provision.ts",
      join(tmpDir, "src/moltzap-eval-provision.ts"),
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

function workspaceTarballSpec(tarball: NanoclawWorkspaceTarball): string {
  return (
    "file:" + posix.join(WORKSPACE_VENDOR_DIRECTORY, tarball.tarballFileName)
  );
}

function copyWorkspaceDependencyTarballs(
  stagingDir: string,
  dependencies: NanoclawWorkspaceDependencies,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const vendorDir = join(stagingDir, WORKSPACE_VENDOR_DIRECTORY);
    yield* fsEffect(
      "create NanoClaw workspace vendor directory",
      fileSystem.makeDirectory(vendorDir, { recursive: true }),
    );
    yield* Effect.forEach(
      [dependencies.client, dependencies.protocol],
      (tarball) =>
        fsEffect(
          `copy ${tarball.packageName} workspace tarball`,
          fileSystem.copyFile(
            tarball.tarballPath,
            join(vendorDir, tarball.tarballFileName),
          ),
        ),
      { concurrency: 2, discard: true },
    );
  });
}

/** @internal */
export function rewriteNanoclawWorkspaceManifest(
  stagingDir: string,
  dependencies: NanoclawWorkspaceDependencies,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const manifestPath = join(stagingDir, "package.json");
    const manifestText = yield* fsEffect(
      "read staged NanoClaw package.json",
      fileSystem.readFileString(manifestPath, "utf8"),
    );
    const rewrittenText = yield* Effect.try({
      try: () => rewriteWorkspaceManifestText(manifestText, dependencies),
      catch: (cause) =>
        cause instanceof NanoclawInstallError
          ? cause
          : installError(
              "Unable to rewrite staged NanoClaw package.json",
              cause,
            ),
    });
    yield* fsEffect(
      "write staged NanoClaw workspace package.json",
      fileSystem.writeFileString(manifestPath, rewrittenText),
    );
  }).pipe(Effect.withSpan("rewriteNanoclawWorkspaceManifest"));
}

function rewriteWorkspaceManifestText(
  manifestText: string,
  dependencies: NanoclawWorkspaceDependencies,
): string {
  const parsed: unknown = JSON.parse(manifestText);
  const manifest = requireRecord(parsed, "staged NanoClaw package.json");
  const manifestDependencies = requireRecord(
    manifest.dependencies,
    "staged NanoClaw dependencies",
  );
  const rewritten = {
    ...manifest,
    dependencies: {
      ...manifestDependencies,
      [CLIENT_PACKAGE_NAME]: workspaceTarballSpec(dependencies.client),
      [PROTOCOL_PACKAGE_NAME]: workspaceTarballSpec(dependencies.protocol),
    },
  };
  return JSON.stringify(rewritten, null, JSON_INDENT_SPACES) + "\n";
}

/** @internal */
export function materializeNanoclawWorkspaceDependencies(
  stagingDir: string,
  dependencies: NanoclawWorkspaceDependencies,
) {
  return Effect.gen(function* () {
    yield* copyWorkspaceDependencyTarballs(stagingDir, dependencies);
    yield* rewriteNanoclawWorkspaceManifest(stagingDir, dependencies);
    yield* execEffect(
      "HUSKY=0 npm install --package-lock-only --ignore-scripts",
      {
        cwd: stagingDir,
        timeout: WORKSPACE_LOCK_TIMEOUT_MS,
      },
    );
    yield* assertNanoclawWorkspaceLock(stagingDir, dependencies);
  }).pipe(Effect.withSpan("materializeNanoclawWorkspaceDependencies"));
}

/** @internal */
export function assertNanoclawWorkspaceLock(
  stagingDir: string,
  dependencies: NanoclawWorkspaceDependencies,
) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fsEffect(
        "read staged NanoClaw workspace package-lock.json",
        fileSystem.readFileString(
          join(stagingDir, "package-lock.json"),
          "utf8",
        ),
      ),
    ),
    Effect.flatMap((lockText) =>
      Effect.try({
        try: () => validateNanoclawWorkspaceLock(lockText, dependencies),
        catch: (cause) =>
          cause instanceof NanoclawInstallError
            ? cause
            : installError(
                "Unable to validate staged NanoClaw workspace package-lock.json",
                cause,
              ),
      }),
    ),
    Effect.withSpan("assertNanoclawWorkspaceLock"),
  );
}

function validateNanoclawWorkspaceLock(
  lockText: string,
  dependencies: NanoclawWorkspaceDependencies,
): void {
  if (REGISTRY_MOLTZAP_PATTERN.test(lockText)) {
    throw installError(
      "NanoClaw workspace lock contains a MoltZap registry artifact",
    );
  }
  const parsed: unknown = JSON.parse(lockText);
  const lock = requireRecord(parsed, "NanoClaw workspace package lock");
  const packages = requireRecord(
    lock.packages,
    "NanoClaw workspace lock packages",
  );
  const root = requireRecord(packages[""], "NanoClaw workspace lock root");
  const rootDependencies = requireRecord(
    root.dependencies,
    "NanoClaw workspace lock root dependencies",
  );
  requireExactValue(
    rootDependencies[CLIENT_PACKAGE_NAME],
    workspaceTarballSpec(dependencies.client),
    "NanoClaw lock client dependency",
  );
  requireExactValue(
    rootDependencies[PROTOCOL_PACKAGE_NAME],
    workspaceTarballSpec(dependencies.protocol),
    "NanoClaw lock protocol dependency",
  );
  requireExactMoltzapPackageKeys(packages);
  validateWorkspaceLockEntry(packages, dependencies.client);
  validateWorkspaceLockEntry(packages, dependencies.protocol);
  const clientEntry = requireRecord(
    packages[`node_modules/${CLIENT_PACKAGE_NAME}`],
    "NanoClaw lock client entry",
  );
  const clientDependencies = requireRecord(
    clientEntry.dependencies,
    "NanoClaw lock client dependencies",
  );
  requireExactValue(
    clientDependencies[PROTOCOL_PACKAGE_NAME],
    dependencies.protocol.version,
    "NanoClaw lock client protocol dependency",
  );
}

function requireExactMoltzapPackageKeys(
  packages: Readonly<Record<string, unknown>>,
): void {
  const actual = Object.keys(packages)
    .filter((location) => location.includes("node_modules/@moltzap/"))
    .sort();
  const expected = [
    `node_modules/${CLIENT_PACKAGE_NAME}`,
    `node_modules/${PROTOCOL_PACKAGE_NAME}`,
  ].sort();
  if (
    actual.length !== expected.length ||
    actual.some((location, index) => location !== expected[index])
  ) {
    throw installError(
      `Expected only direct MoltZap workspace lock entries; found ${actual.join(", ") || "none"}`,
    );
  }
}

function validateWorkspaceLockEntry(
  packages: Readonly<Record<string, unknown>>,
  tarball: NanoclawWorkspaceTarball,
): void {
  const location = `node_modules/${tarball.packageName}`;
  const entry = requireRecord(
    packages[location],
    `NanoClaw lock entry ${location}`,
  );
  requireExactValue(entry.version, tarball.version, `${location} version`);
  requireExactValue(
    entry.resolved,
    workspaceTarballSpec(tarball),
    `${location} resolved`,
  );
  requireExactValue(
    entry.integrity,
    tarball.integrity,
    `${location} integrity`,
  );
}

function optionalRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  return value === undefined ? {} : requireRecord(value, label);
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
  // checkout path; the simulator owns naming (one fingerprint-tagged image
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
    '"node_modules/.bin/tsx" scripts/upgrade-state.ts set "" moltzap-simulator',
    { cwd: sourceDir, timeout: 60_000 },
  );
}

function buildAndPublish(target: NanoclawCacheTarget) {
  const cache = nanoclawInstallCache(target.cacheRoot);
  return Effect.gen(function* () {
    const buildingDir = yield* cache.createBuildingCache();
    return yield* Effect.gen(function* () {
      const buildingInstall = runtimeInstall(
        buildingDir,
        target.cacheFingerprint,
      );
      yield* downloadPinnedSource(buildingDir);
      yield* injectBundledAssets(buildingDir);
      if (target.installMode === "workspace") {
        yield* materializeNanoclawWorkspaceDependencies(
          buildingDir,
          target.workspaceDependencies,
        );
      }
      yield* buildRuntime(buildingInstall);
      yield* cache.writeReadyMarker(buildingDir, target.cacheFingerprint);
      const generationDir = yield* cache.publishCacheGeneration(buildingDir);
      return runtimeInstall(generationDir, target.cacheFingerprint);
    }).pipe(Effect.ensuring(cache.removeBuildingCacheBestEffort(buildingDir)));
  });
}

export function ensureNanoclawRuntimeInstalledEffect(installMode: InstallMode) {
  return Effect.scoped(
    WARM_INSTALLS.getOrAcquire(
      installMode,
      CACHE_BUILD_PERMIT.withPermits(1)(
        Effect.gen(function* () {
          const target = yield* resolveCacheTarget(installMode);
          return yield* verifyOrBuildInstall(target);
        }),
      ),
    ),
  ).pipe(Effect.withSpan("ensureNanoclawRuntimeInstalledEffect"));
}

function warmNanoclawInstall(installMode: InstallMode) {
  return WARM_INSTALLS.peek(installMode);
}

function verifyOrBuildInstall(target: NanoclawCacheTarget) {
  const cache = nanoclawInstallCache(target.cacheRoot);
  return Effect.gen(function* () {
    yield* cache.sweepStaleBuildingCaches();
    yield* preflightDocker();
    const generationDir = yield* cache.findCacheGeneration(
      target.cacheFingerprint,
    );
    if (generationDir === null) return yield* buildAndPublish(target);
    const install = runtimeInstall(generationDir, target.cacheFingerprint);
    yield* ensureContainerImage(install);
    return install;
  });
}
