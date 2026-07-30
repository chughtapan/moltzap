/** @file Immutable OpenClaw channel-plugin materialization. */

import { basename, dirname, join } from "node:path";
import { execPath } from "node:process";
import { FileSystem } from "@effect/platform";
import { Data, Effect, Ref, Schema } from "effect";
import {
  baseChildEnvironmentConfig,
  makeCommandHelpers,
  makeExactEnvironmentCommand,
  type CapturedCommandOutput,
} from "../command.js";
import {
  cacheFingerprint,
  CACHE_BUILD_PERMIT,
  makeJsonGuards,
  makeImmutableCache,
  MOLTZAP_SIMULATOR_CACHE_ROOT,
} from "../cache.js";
import { resolveInstalledPackageDependency } from "../packages.js";

const CHANNEL_PACKAGE_NAME = "@moltzap/openclaw-channel";
const OPENCLAW_PACKAGE_NAME = "openclaw";
const OPENCLAW_PLUGIN_ID = "openclaw-channel";
const OPENCLAW_CACHE_SCHEMA_VERSION = 1;
const OPENCLAW_INSTALL_TIMEOUT_MS = 120_000;
const OPENCLAW_LIST_TIMEOUT_MS = 30_000;
const NPM_REGISTRY_PREFIX = "https://registry.npmjs.org/";
const NPM_INTEGRITY_PREFIX = "sha512-";

const openClawPluginListOutput = Schema.Struct({
  plugins: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      enabled: Schema.Boolean,
      status: Schema.String,
    }),
  ),
});

// Everything a cache generation is keyed by and built from. The pinned
// dependency resolution is process-constant; only `cacheRoot` varies, because
// tests redirect the cache away from the shared root.
interface OpenClawPluginCacheTargetInput {
  readonly cacheFingerprint: string;
  readonly channelSpec: string;
  readonly channelVersion: string;
  readonly openclawPackageRoot: string;
}

interface OpenClawPluginCacheTarget extends OpenClawPluginCacheTargetInput {
  readonly cacheRoot: string;
}

interface WarmCacheGeneration {
  readonly cacheFingerprint: string;
  readonly cacheRoot: string;
  readonly generationDir: string;
}

/** Configures materialize published open claw plugin. */
export interface MaterializePublishedOpenClawPluginOptions {
  readonly stateDir: string;
  readonly openclawBin: string;
  readonly cacheBaseDir?: string;
}

// A published generation is immutable, so the first spawn's resolution answers
// for every later spawn instead of re-sweeping and re-scanning the cache.
const WARM_CACHE_GENERATION = Effect.runSync(
  Ref.make<WarmCacheGeneration | null>(null),
);

class OpenClawPluginCacheError extends Data.TaggedError(
  "OpenClawPluginCacheError",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.reason;
  }
}

function cacheError(reason: string, cause?: unknown) {
  return new OpenClawPluginCacheError({
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
}

const { commandOutputEffect, fsEffect } = makeCommandHelpers(cacheError);
const {
  isRecord,
  requireExactValue,
  requireRecord,
  requireSoleEntry,
  requireString,
} = makeJsonGuards(cacheError);

/**
 * Installs or reuses the pinned npm project and copies it into one agent's
 * state directory with a peer link to the simulator's OpenClaw package.
 * @param options Options that control the operation.
 * @returns The materialize published open claw plugin result.
 */
export function materializePublishedOpenClawPlugin(
  options: MaterializePublishedOpenClawPluginOptions,
) {
  return Effect.gen(function* () {
    const target = yield* resolveCacheTarget(options.cacheBaseDir);
    const generationDir = yield* resolveCacheGeneration(
      target,
      options.openclawBin,
    );
    return yield* materializeOpenClawPluginCacheGeneration({
      generationDir,
      stateDir: options.stateDir,
      openclawPackageRoot: target.openclawPackageRoot,
    });
  }).pipe(Effect.withSpan("materializePublishedOpenClawPlugin"));
}

// The installed dependency versions and this host's identity cannot change
// while the process runs, so the two directory-walking package resolutions and
// the digest run once for every agent it spawns.
const cachedCacheTargetInput = Effect.runSync(
  Effect.cached(
    Effect.try({
      try: (): OpenClawPluginCacheTargetInput => {
        const channel = resolveInstalledPackageDependency(
          "@moltzap/simulator",
          CHANNEL_PACKAGE_NAME,
          import.meta.url,
        );
        const openclaw = resolveInstalledPackageDependency(
          "@moltzap/simulator",
          OPENCLAW_PACKAGE_NAME,
          import.meta.url,
        );
        return {
          cacheFingerprint: openClawPluginCacheFingerprint({
            channelVersion: channel.version,
            openclawVersion: openclaw.version,
            platform: process.platform,
            architecture: process.arch,
          }),
          channelSpec: `${CHANNEL_PACKAGE_NAME}@${channel.version}`,
          channelVersion: channel.version,
          openclawPackageRoot: openclaw.packageRoot,
        };
      },
      catch: (cause) =>
        cacheError(
          "Unable to resolve exact simulator dependencies for the published OpenClaw plugin cache",
          cause,
        ),
    }),
  ),
);

function resolveCacheTarget(cacheBaseDir?: string) {
  return cachedCacheTargetInput.pipe(
    Effect.map(
      (input) =>
        ({
          ...input,
          cacheRoot: join(
            cacheBaseDir ??
              join(MOLTZAP_SIMULATOR_CACHE_ROOT, "openclaw-plugin"),
            input.cacheFingerprint,
          ),
        }) satisfies OpenClawPluginCacheTarget,
    ),
  );
}

/**
 * Derive the immutable OpenClaw plugin cache identity.
 *
 * @param input Input value to process.
 * @param input.channelVersion Value supplied to the operation.
 * @param input.openclawVersion Value supplied to the operation.
 * @param input.platform Value supplied to the operation.
 * @param input.architecture Value supplied to the operation.
 * @internal
 * @returns The open claw plugin cache fingerprint result.
 */
export function openClawPluginCacheFingerprint(input: {
  readonly channelVersion: string;
  readonly openclawVersion: string;
  readonly platform: string;
  readonly architecture: string;
}): string {
  return cacheFingerprint(OPENCLAW_CACHE_SCHEMA_VERSION, {
    channelVersion: input.channelVersion,
    openclawVersion: input.openclawVersion,
    platform: input.platform,
    architecture: input.architecture,
  });
}

function resolveCacheGeneration(
  target: OpenClawPluginCacheTarget,
  openclawBin: string,
) {
  return Effect.gen(function* () {
    const warm = yield* Ref.get(WARM_CACHE_GENERATION);
    if (
      warm !== null &&
      warm.cacheFingerprint === target.cacheFingerprint &&
      warm.cacheRoot === target.cacheRoot
    ) {
      return warm.generationDir;
    }
    const generationDir = yield* CACHE_BUILD_PERMIT.withPermits(1)(
      ensureCacheGeneration(target, openclawBin),
    );
    yield* Ref.set(WARM_CACHE_GENERATION, {
      cacheFingerprint: target.cacheFingerprint,
      cacheRoot: target.cacheRoot,
      generationDir,
    });
    return generationDir;
  });
}

function ensureCacheGeneration(
  target: OpenClawPluginCacheTarget,
  openclawBin: string,
) {
  const cache = makeImmutableCache(target.cacheRoot, cacheError);
  return Effect.gen(function* () {
    yield* cache.sweepStaleBuildingCaches();
    const ready = yield* cache.findCacheGeneration(target.cacheFingerprint);
    if (ready !== null) {
      return ready;
    }
    return yield* buildAndPublishCacheGeneration(target, openclawBin);
  });
}

function buildAndPublishCacheGeneration(
  target: OpenClawPluginCacheTarget,
  openclawBin: string,
) {
  const cache = makeImmutableCache(target.cacheRoot, cacheError);
  return Effect.gen(function* () {
    const buildingDir = yield* cache.createBuildingCache();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stagingHome = yield* fsEffect(
          "create isolated OpenClaw plugin staging home",
          fileSystem.makeTempDirectoryScoped({
            prefix: "moltzap-openclaw-plugin-",
          }),
        );
        yield* coldInstallPlugin(openclawBin, stagingHome, target);
        const sourceProjectDir = yield* findInstalledChannelProject(
          join(stagingHome, ".openclaw", "npm", "projects"),
          target.channelVersion,
        );
        yield* validateOpenClawPluginProject(
          sourceProjectDir,
          target.channelVersion,
        );
        yield* copyProjectIntoBuildingCache(sourceProjectDir, buildingDir);
        yield* cache.writeReadyMarker(buildingDir, target.cacheFingerprint);
        return yield* cache.publishCacheGeneration(buildingDir);
      }),
    ).pipe(Effect.ensuring(cache.removeBuildingCacheBestEffort(buildingDir)));
  });
}

function coldInstallPlugin(
  openclawBin: string,
  stagingHome: string,
  target: OpenClawPluginCacheTarget,
) {
  const stateDir = join(stagingHome, ".openclaw");
  const environment = {
    OPENCLAW_HOME: stagingHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
  };
  return Effect.gen(function* () {
    const installCommand = yield* makeOpenClawCommand(
      openclawBin,
      ["plugins", "install", target.channelSpec, "--pin"],
      environment,
      stagingHome,
    );
    const listCommand = yield* makeOpenClawCommand(
      openclawBin,
      ["plugins", "list", "--enabled", "--json"],
      environment,
      stagingHome,
    );
    yield* commandOutputEffect(
      `install ${target.channelSpec} with OpenClaw`,
      installCommand,
      { timeout: OPENCLAW_INSTALL_TIMEOUT_MS },
    );
    const listed = yield* commandOutputEffect(
      "list enabled OpenClaw plugins",
      listCommand,
      { timeout: OPENCLAW_LIST_TIMEOUT_MS },
    );
    yield* verifyEnabledPlugin(listed);
  });
}

/**
 * Builds one OpenClaw CLI invocation under an exact environment rather than
 * the operator's: ambient variables change the CLI's behavior (a test-runner
 * marker silences its JSON output entirely), which would make cache builds
 * depend on who launched them.
 * @param openclawBin Value supplied to the operation.
 * @param args Value supplied to the operation.
 * @param environment Value supplied to the operation.
 * @param cwd Value supplied to the operation.
 * @internal
 * @returns The created open claw command.
 */
export function makeOpenClawCommand(
  openclawBin: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  cwd: string,
) {
  const isNodeScript = openclawBin.endsWith(".mjs");
  return Effect.map(baseChildEnvironmentConfig, (base) =>
    makeExactEnvironmentCommand({
      command: isNodeScript ? execPath : openclawBin,
      args: isNodeScript ? [openclawBin, ...args] : [...args],
      cwd,
      env: { ...base, ...environment },
    }),
  );
}

function verifyEnabledPlugin(output: CapturedCommandOutput) {
  return Effect.try({
    try: (): unknown => JSON.parse(output.stdout),
    catch: (cause) =>
      cacheError("OpenClaw plugins list returned invalid JSON", cause),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(openClawPluginListOutput)),
    Effect.mapError((cause) =>
      cause instanceof OpenClawPluginCacheError
        ? cause
        : cacheError("Unable to decode OpenClaw plugins list", cause),
    ),
    Effect.flatMap((decoded) => {
      const plugin = decoded.plugins.find(
        (candidate) => candidate.id === OPENCLAW_PLUGIN_ID,
      );
      return plugin?.enabled === true && plugin.status === "loaded"
        ? Effect.void
        : Effect.fail(
            cacheError(
              `OpenClaw did not report ${OPENCLAW_PLUGIN_ID} enabled and loaded after install`,
            ),
          );
    }),
  );
}

function findInstalledChannelProject(
  projectsDir: string,
  channelVersion: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fsEffect(
      "list installed OpenClaw npm projects " + projectsDir,
      fileSystem.readDirectory(projectsDir),
    );
    const matches = yield* Effect.filter(entries, (entry) =>
      projectDeclaresChannel(
        join(projectsDir, entry, "package.json"),
        channelVersion,
      ),
    );
    const match = yield* requireSoleEntry(
      matches,
      `OpenClaw npm project for ${CHANNEL_PACKAGE_NAME}@${channelVersion}`,
    );
    return join(projectsDir, match);
  });
}

function projectDeclaresChannel(
  packageJsonPath: string,
  channelVersion: string,
) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.readFileString(packageJsonPath, "utf8"),
    ),
    Effect.flatMap((contents) =>
      Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(contents);
          return (
            isRecord(parsed) &&
            isRecord(parsed.dependencies) &&
            parsed.dependencies[CHANNEL_PACKAGE_NAME] === channelVersion
          );
        },
        catch: () => false,
      }).pipe(Effect.merge),
    ),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

/**
 * Validate the materialized OpenClaw plugin project and its channel dependency.
 *
 * @param projectDir Value supplied to the operation.
 * @param channelVersion Value supplied to the operation.
 * @internal
 * @returns The validate open claw plugin project result.
 */
export function validateOpenClawPluginProject(
  projectDir: string,
  channelVersion: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const [manifestText, lockText] = yield* Effect.all([
      fsEffect(
        "read OpenClaw npm project manifest",
        fileSystem.readFileString(join(projectDir, "package.json"), "utf8"),
      ),
      fsEffect(
        "read OpenClaw npm project lock",
        fileSystem.readFileString(
          join(projectDir, "package-lock.json"),
          "utf8",
        ),
      ),
    ]);
    yield* Effect.try({
      try: () => {
        validateProjectProvenance(
          JSON.parse(manifestText),
          JSON.parse(lockText),
          channelVersion,
        );
      },
      catch: (cause) =>
        cause instanceof OpenClawPluginCacheError
          ? cause
          : cacheError("Unable to validate OpenClaw npm provenance", cause),
    });
  }).pipe(Effect.withSpan("validateOpenClawPluginProject"));
}

function validateProjectProvenance(
  manifest: unknown,
  lock: unknown,
  channelVersion: string,
): void {
  const manifestRecord = requireRecord(manifest, "npm project package.json");
  const manifestDependencies = requireRecord(
    manifestRecord.dependencies,
    "npm project dependencies",
  );
  requireExactValue(
    manifestDependencies[CHANNEL_PACKAGE_NAME],
    channelVersion,
    "npm project channel dependency",
  );
  const lockRecord = requireRecord(lock, "npm project package-lock.json");
  const lockPackages = requireRecord(
    lockRecord.packages,
    "npm project lock packages",
  );
  const rootLock = requireRecord(lockPackages[""], "npm project lock root");
  const rootDependencies = requireRecord(
    rootLock.dependencies,
    "npm project lock root dependencies",
  );
  requireExactValue(
    rootDependencies[CHANNEL_PACKAGE_NAME],
    channelVersion,
    "npm lock channel dependency",
  );
  validateMoltzapLockEntries(lockPackages, channelVersion);
}

function validateMoltzapLockEntries(
  lockPackages: Readonly<Record<string, unknown>>,
  channelVersion: string,
): void {
  let channelFound = false;
  for (const [location, value] of Object.entries(lockPackages)) {
    if (!location.includes("node_modules/@moltzap/")) {
      continue;
    }
    const entry = requireRecord(value, `npm lock entry ${location}`);
    const resolved = requireString(entry.resolved, `${location} resolved`);
    const integrity = requireString(entry.integrity, `${location} integrity`);
    if (
      entry.link === true ||
      !resolved.startsWith(NPM_REGISTRY_PREFIX) ||
      !integrity.startsWith(NPM_INTEGRITY_PREFIX)
    ) {
      throw cacheError(
        `Published OpenClaw plugin dependency ${location} is not registry-backed with sha512 integrity`,
      );
    }
    if (location.endsWith(`node_modules/${CHANNEL_PACKAGE_NAME}`)) {
      requireExactValue(
        entry.version,
        channelVersion,
        "installed channel version",
      );
      channelFound = true;
    }
  }
  if (!channelFound) {
    throw cacheError(
      `OpenClaw npm lock does not contain ${CHANNEL_PACKAGE_NAME}`,
    );
  }
}

function copyProjectIntoBuildingCache(
  sourceProjectDir: string,
  buildingDir: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const destination = join(
      buildingDir,
      "npm",
      "projects",
      basename(sourceProjectDir),
    );
    yield* fsEffect(
      "copy OpenClaw npm project into immutable cache",
      fileSystem.copy(sourceProjectDir, destination),
    );
    yield* fsEffect(
      "remove cached OpenClaw peer link",
      fileSystem.remove(openclawPeerLinkPath(destination), {
        recursive: true,
        force: true,
      }),
    );
  });
}

/**
 * Copies one cached npm project and rebuilds the only machine-specific link.
 * @param options Options that control the operation.
 * @param options.generationDir Value supplied to the operation.
 * @param options.stateDir Value supplied to the operation.
 * @param options.openclawPackageRoot Value supplied to the operation.
 * @internal
 * @returns The materialize open claw plugin cache generation result.
 */
export function materializeOpenClawPluginCacheGeneration(options: {
  readonly generationDir: string;
  readonly stateDir: string;
  readonly openclawPackageRoot: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cachedProjectsDir = join(options.generationDir, "npm", "projects");
    const entries = yield* fsEffect(
      "list cached OpenClaw npm projects",
      fileSystem.readDirectory(cachedProjectsDir),
    );
    const entry = yield* requireSoleEntry(
      entries,
      "cached OpenClaw npm project",
    );
    const projectDir = join(options.stateDir, "npm", "projects", entry);
    yield* fsEffect(
      "materialize cached OpenClaw npm project",
      fileSystem.copy(join(cachedProjectsDir, entry), projectDir),
    );
    yield* recreateOpenClawPeerLink(projectDir, options.openclawPackageRoot);
    return projectDir;
  }).pipe(Effect.withSpan("materializeOpenClawPluginCacheGeneration"));
}

function recreateOpenClawPeerLink(
  projectDir: string,
  openclawPackageRoot: string,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fsEffect(
      "inspect simulator-resolved OpenClaw package root",
      fileSystem.stat(openclawPackageRoot),
    );
    if (info.type !== "Directory") {
      return yield* Effect.fail(
        cacheError(
          `Unable to resolve OpenClaw peer link target at ${openclawPackageRoot}`,
        ),
      );
    }
    const peerLink = openclawPeerLinkPath(projectDir);
    const canonicalRoot = yield* fsEffect(
      "canonicalize simulator-resolved OpenClaw package root",
      fileSystem.realPath(openclawPackageRoot),
    );
    yield* fsEffect(
      "remove stale OpenClaw peer link",
      fileSystem.remove(peerLink, { recursive: true, force: true }),
    );
    yield* fsEffect(
      "create OpenClaw peer link",
      fileSystem
        .makeDirectory(dirname(peerLink), { recursive: true })
        .pipe(Effect.zipRight(fileSystem.symlink(canonicalRoot, peerLink))),
    );
  }).pipe(
    Effect.mapError((cause) =>
      cacheError(
        `Unable to resolve OpenClaw peer link target at ${openclawPackageRoot}`,
        cause,
      ),
    ),
  );
}

function openclawPeerLinkPath(projectDir: string): string {
  return join(
    projectDir,
    "node_modules",
    "@moltzap",
    "openclaw-channel",
    "node_modules",
    "openclaw",
  );
}
