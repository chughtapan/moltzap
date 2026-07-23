/**
 * Shared plugin-install + workspace-seed helpers consumed by every
 * runtime adapter that needs to drop a moltzap channel package onto disk
 * for an external agent runtime to load.
 *
 * `openclaw-adapter` installs a channel package into a per-agent state dir,
 * then either copies or symlinks the runtime imports the package resolves at
 * load time.
 */
import { createRequire } from "node:module";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Redacted, Schema } from "effect";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import type { SpawnInput } from "./runtime.js";

const PROFILE_CONFIG_INDENT_SPACES = 2;
const PROFILE_CONFIG_FILE_MODE = 0o600;
const PROFILE_CONFIG_FILE_NAME = "config.json";

/** Profile selector shared by isolated testbed runtime state directories. */
export const TESTBED_PROFILE_NAME = "testbed-agent";

const ChannelPackageManifest = Schema.parseJson(
  Schema.Struct({
    dependencies: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.String }),
      { default: () => ({}) },
    ),
  }),
);

/**
 * Serializes the per-agent MoltZap profile config that every runtime
 * adapter drops at the agent state dir's `.moltzap/config.json`. The spawned
 * channel finds it through `MOLTZAP_CONFIG_HOME`, then selects the fixed
 * testbed profile through the runtime-specific account selector.
 */
export function serializeMoltZapProfileConfig(profile: {
  readonly agentName: string;
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
}): string {
  return JSON.stringify(
    {
      profiles: {
        [TESTBED_PROFILE_NAME]: {
          agentId: profile.agentId,
          apiKey: Redacted.value(profile.apiKey),
          agentName: profile.agentName,
        },
      },
    },
    null,
    PROFILE_CONFIG_INDENT_SPACES,
  );
}

/** Writes the credentials used by a runtime's isolated channel process. */
export function writeMoltZapProfileConfig(
  configHome: string,
  profile: {
    readonly agentName: string;
    readonly agentId: AgentId;
    readonly apiKey: AgentKey;
  },
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = path.join(configHome, PROFILE_CONFIG_FILE_NAME);

    yield* fileSystem.makeDirectory(configHome, { recursive: true });
    yield* fileSystem.writeFileString(
      configPath,
      serializeMoltZapProfileConfig(profile),
      { mode: PROFILE_CONFIG_FILE_MODE },
    );
    yield* fileSystem.chmod(configPath, PROFILE_CONFIG_FILE_MODE);
  }).pipe(Effect.withSpan("writeMoltZapProfileConfig"));
}

class ChannelPluginInstallError extends Data.TaggedError(
  "ChannelPluginInstallError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface InstallChannelPluginOpts {
  readonly stateDir: string;
  readonly channelDistDir: string;
  /** Subdirectory under `&lt;stateDir>/extensions/`. */
  readonly extName: string;

  /**
   * Extra files copied verbatim from the channel package root into the
   * installed extension dir. Each entry is a basename (e.g.
   * `openclaw.plugin.json`); silently skipped if not present.
   */
  readonly extraPackageFiles?: ReadonlyArray<string>;
}

interface CopyDirectoryContext {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly root: string;
}

interface LinkChannelDependenciesContext {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly channelPackageDir: string;
  readonly pluginNodeModules: string;
}

interface PackageResolution {
  readonly packageRoot: string | null;
  readonly warning: unknown | null;
}

/**
 * Install a moltzap channel package into a per-agent state dir.
 *
 * Standard layout produced:
 *   &lt;stateDir>/extensions/&lt;extName>/dist/...      ← copied from channelDistDir
 *   &lt;stateDir>/extensions/&lt;extName>/package.json  ← copied from channel pkg root
 *   &lt;stateDir>/extensions/&lt;extName>/node_modules/... → each declared channel dependency
 *   &lt;stateDir>/extensions/&lt;extName>/&lt;extraPackageFiles[i]>         (when present)
 *
 * Returns the absolute path to the installed extension dir.
 */
export function installChannelPlugin(
  opts: InstallChannelPluginOpts,
): Effect.Effect<
  string,
  ChannelPluginInstallError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const extDir = path.join(opts.stateDir, "extensions", opts.extName);
    const channelPackageDir = path.dirname(opts.channelDistDir);

    yield* fileSystem.makeDirectory(extDir, { recursive: true });
    yield* copyDistDirectory(
      fileSystem,
      path,
      opts.channelDistDir,
      path.join(extDir, "dist"),
    );
    yield* copyPackageFiles({
      fileSystem,
      path,
      channelPackageDir,
      extDir,
      extraPackageFiles: opts.extraPackageFiles ?? [],
    });
    const pluginNm = path.join(extDir, "node_modules");
    yield* linkChannelDependencies({
      fileSystem,
      path,
      channelPackageDir,
      pluginNodeModules: pluginNm,
    });

    return extDir;
  }).pipe(Effect.withSpan("installChannelPlugin"));
}

function copyPackageFiles(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly channelPackageDir: string;
  readonly extDir: string;
  readonly extraPackageFiles: ReadonlyArray<string>;
}): Effect.Effect<void, PlatformError> {
  return Effect.gen(function* () {
    const packageJsonPath = input.path.join(
      input.channelPackageDir,
      "package.json",
    );
    yield* copyFileIfExists(
      input.fileSystem,
      packageJsonPath,
      input.path.join(input.extDir, "package.json"),
    );
    for (const extra of input.extraPackageFiles) {
      const src = input.path.join(input.channelPackageDir, extra);
      yield* copyFileIfExists(
        input.fileSystem,
        src,
        input.path.join(input.extDir, extra),
      );
    }
  });
}

function linkChannelDependencies(
  context: LinkChannelDependenciesContext,
): Effect.Effect<
  void,
  ChannelPluginInstallError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const dependencyNames = yield* readChannelDependencyNames(context);
    for (const packageName of dependencyNames) {
      yield* linkChannelDependency(context, packageName);
    }
  });
}

function readChannelDependencyNames(
  context: LinkChannelDependenciesContext,
): Effect.Effect<
  ReadonlyArray<string>,
  ChannelPluginInstallError | PlatformError
> {
  return Effect.gen(function* () {
    const manifestPath = context.path.join(
      context.channelPackageDir,
      "package.json",
    );
    const source = yield* context.fileSystem.readFileString(manifestPath);
    const manifest = yield* Schema.decodeUnknown(ChannelPackageManifest)(
      source,
    ).pipe(
      Effect.catchTag("ParseError", (cause) =>
        Effect.fail(
          new ChannelPluginInstallError({
            cause,
            message: `channel-plugin-install: invalid package manifest at ${manifestPath}`,
          }),
        ),
      ),
    );
    return Object.keys(manifest.dependencies);
  });
}

function linkChannelDependency(
  context: LinkChannelDependenciesContext,
  packageName: string,
): Effect.Effect<
  void,
  ChannelPluginInstallError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const resolved = yield* resolveChannelDependency(
      context.channelPackageDir,
      packageName,
    );
    if (resolved === null) {
      return yield* Effect.fail(
        new ChannelPluginInstallError({
          message: `channel-plugin-install: cannot resolve declared dependency ${packageName} from ${context.channelPackageDir}`,
        }),
      );
    }
    const linkTarget = context.path.join(
      context.pluginNodeModules,
      packageName,
    );
    yield* context.fileSystem.makeDirectory(context.path.dirname(linkTarget), {
      recursive: true,
    });
    yield* context.fileSystem.symlink(resolved, linkTarget);
  });
}

/**
 * Drop SpawnInput.workspaceFiles into `&lt;stateDir>/workspace/`. Identical
 * shape between adapters; lifted here so they share one implementation.
 */
export function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): Effect.Effect<
  void,
  PlatformError | ChannelPluginInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    if (workspaceFiles === undefined) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceDir = path.join(stateDir, "workspace");
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    for (const file of workspaceFiles) {
      const destination = resolveWorkspaceFileDestination(
        path,
        workspaceDir,
        file.relativePath,
      );
      if (destination === null) {
        return yield* Effect.fail(
          new ChannelPluginInstallError({
            message: `workspace path must stay below its agent root: ${file.relativePath}`,
          }),
        );
      }
      yield* fileSystem.makeDirectory(path.dirname(destination), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(destination, file.content);
    }
  }).pipe(Effect.withSpan("seedWorkspaceFiles"));
}

export function resolveWorkspaceFileDestination(
  path: Path.Path,
  workspaceRoot: string,
  relativePath: string,
): string | null {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return null;
  }
  const root = path.resolve(workspaceRoot);
  const destination = path.resolve(root, relativePath);
  const relativeDestination = path.relative(root, destination);
  if (
    relativeDestination.length === 0 ||
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDestination)
  ) {
    return null;
  }
  return destination;
}

/** Resolves a runtime dependency imported by the channel package. */
export function resolveChannelDependency(
  channelPackageDir: string,
  packageName: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const anchor = path.join(channelPackageDir, "package.json");
    const anchorExists = yield* fileSystem
      .exists(anchor)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!anchorExists) {
      return null;
    }

    const resolutionAnchor = yield* fileSystem
      .realPath(anchor)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            "failed to resolve real channel package path; using linked path",
            cause,
          ).pipe(Effect.as(anchor)),
        ),
      );
    const resolution = resolvePackageRoot(resolutionAnchor, path, packageName);
    if (resolution.warning !== null) {
      yield* Effect.logWarning(
        "failed to resolve channel dependency",
        resolution.warning,
      );
    }
    return resolution.packageRoot;
  }).pipe(Effect.withSpan("resolveChannelDependency"));
}

function resolvePackageRoot(
  anchor: string,
  path: Path.Path,
  packageName: string,
): PackageResolution {
  try {
    const requireFromAnchor = createRequire(anchor);
    const packageJsonCandidates = [
      `${packageName}/package.json`,
      ...(requireFromAnchor.resolve.paths(packageName) ?? []).map(
        (lookupPath) => path.join(lookupPath, packageName, "package.json"),
      ),
    ];
    return resolveFirstPackageJson(
      requireFromAnchor,
      path,
      packageJsonCandidates,
    );
  } catch (cause) {
    return {
      packageRoot: null,
      warning: isExpectedResolutionFailure(cause) ? null : cause,
    };
  }
}

function resolveFirstPackageJson(
  requireFromAnchor: NodeRequire,
  path: Path.Path,
  candidates: ReadonlyArray<string>,
): PackageResolution {
  let firstError: unknown = null;
  for (const candidate of candidates) {
    try {
      return {
        packageRoot: path.dirname(requireFromAnchor.resolve(candidate)),
        warning: null,
      };
    } catch (cause) {
      firstError ??= cause;
    }
  }
  return {
    packageRoot: null,
    warning: isExpectedResolutionFailure(firstError) ? null : firstError,
  };
}

function isExpectedResolutionFailure(cause: unknown): boolean {
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  return (
    code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
}

function copyFileIfExists(
  fileSystem: FileSystem.FileSystem,
  src: string,
  dest: string,
): Effect.Effect<void, PlatformError> {
  return Effect.gen(function* () {
    const exists = yield* fileSystem.exists(src);
    if (!exists) return;
    yield* fileSystem.copyFile(src, dest);
  });
}

function copyDistDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  src: string,
  dest: string,
): Effect.Effect<void, PlatformError> {
  return copyFilteredDirectory({ fileSystem, path, root: src }, src, dest);
}

function copyFilteredDirectory(
  context: CopyDirectoryContext,
  src: string,
  dest: string,
): Effect.Effect<void, PlatformError> {
  return Effect.gen(function* () {
    const rel = context.path.relative(context.root, src);
    if (rel.startsWith("node_modules") || rel.startsWith("src")) {
      return;
    }

    const info = yield* context.fileSystem.stat(src);
    if (info.type === "Directory") {
      yield* context.fileSystem.makeDirectory(dest, { recursive: true });
      const entries = yield* context.fileSystem.readDirectory(src);
      for (const entry of entries) {
        yield* copyFilteredDirectory(
          context,
          context.path.join(src, entry),
          context.path.join(dest, entry),
        );
      }
      return;
    }

    if (info.type === "File") {
      yield* context.fileSystem.makeDirectory(context.path.dirname(dest), {
        recursive: true,
      });
      yield* context.fileSystem.copyFile(src, dest);
    }
  });
}
