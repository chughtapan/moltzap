/**
 * Shared plugin-install + workspace-seed helpers consumed by every
 * runtime adapter that needs to drop a moltzap channel package onto disk
 * for an external agent runtime to load.
 *
 * Both `openclaw-adapter` and `claude-code-adapter` install a channel
 * package into a per-agent state dir, then either copy or symlink the
 * runtime imports the package resolves at load time. The two adapters
 * differ only in:
 *   - The extension subdirectory name (`openclaw-channel` vs
 *     `claude-code-channel`).
 *   - Whether the channel package ships an additional manifest file
 *     (`openclaw.plugin.json` for openclaw; cc-channel ships none).
 *   - Which runtime modules need to resolve from the plugin's local
 *     `node_modules` (openclaw symlinks `effect`; cc-channel additionally
 *     symlinks `@modelcontextprotocol/sdk`).
 *
 * Per the "minimize tech debt" team memory: factor the shared shape out
 * now that two live adapters consume it.
 */
import { createRequire } from "node:module";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Redacted } from "effect";
import type { AgentId, AgentKey } from "@moltzap/protocol/identity";
import type { SpawnInput } from "./runtime.js";

const PROFILE_CONFIG_INDENT_SPACES = 2;

/**
 * Serializes the per-agent MoltZap profile config that every runtime
 * adapter drops at the agent state dir's `.moltzap/config.json`; the spawned
 * channel loads it via `MOLTZAP_PROFILE` + `MOLTZAP_CONFIG_HOME`.
 */
export function serializeMoltZapProfileConfig(profile: {
  readonly agentName: string;
  readonly agentId: AgentId;
  readonly apiKey: AgentKey;
}): string {
  return JSON.stringify(
    {
      profiles: {
        [profile.agentName]: {
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

class ChannelPluginInstallError extends Data.TaggedError(
  "ChannelPluginInstallError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface PluginSymlinkSpec {
  /** Path inside the plugin's `node_modules/` (e.g. `effect`, `@x/y`). */
  readonly linkPath: string;

  /**
   * Ordered candidate source paths. The first existing candidate is used.
   * Throws if none exist — surface the missing dep as a config error
   * rather than a runtime ENOENT inside the spawned subprocess.
   */
  readonly candidates: ReadonlyArray<string>;
}

export interface InstallChannelPluginOpts {
  readonly stateDir: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
  /** Subdirectory under `&lt;stateDir>/extensions/`. */
  readonly extName: string;

  /**
   * Extra files copied verbatim from the channel package root into the
   * installed extension dir. Each entry is a basename (e.g.
   * `openclaw.plugin.json`); silently skipped if not present.
   */
  readonly extraPackageFiles?: ReadonlyArray<string>;

  /**
   * Extra symlinks to create under `&lt;extDir>/node_modules/`. Each is
   * tried against an ordered list of candidate sources; first hit wins.
   */
  readonly extraSymlinks?: ReadonlyArray<PluginSymlinkSpec>;
}

interface CopyDirectoryContext {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly root: string;
}

/**
 * Install a moltzap channel package into a per-agent state dir.
 *
 * Standard layout produced:
 *   &lt;stateDir>/extensions/&lt;extName>/dist/...      ← copied from channelDistDir
 *   &lt;stateDir>/extensions/&lt;extName>/package.json  ← copied from channel pkg root
 *   &lt;stateDir>/extensions/&lt;extName>/node_modules/@moltzap/protocol → repoRoot/packages/protocol
 *   &lt;stateDir>/extensions/&lt;extName>/node_modules/@moltzap/client   → repoRoot/packages/client
 *   &lt;stateDir>/extensions/&lt;extName>/&lt;extraPackageFiles[i]>         (when present)
 *   &lt;stateDir>/extensions/&lt;extName>/node_modules/&lt;extraSymlinks[i].linkPath> → first existing candidate
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
    yield* linkWorkspacePackages(fileSystem, path, opts.repoRoot, pluginNm);
    yield* linkExtraSymlinks(
      fileSystem,
      path,
      pluginNm,
      opts.extraSymlinks ?? [],
    );

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

function linkWorkspacePackages(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  repoRoot: string,
  pluginNm: string,
): Effect.Effect<void, PlatformError> {
  return Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.join(pluginNm, "@moltzap"), {
      recursive: true,
    });
    yield* fileSystem.symlink(
      path.join(repoRoot, "packages/protocol"),
      path.join(pluginNm, "@moltzap/protocol"),
    );
    yield* fileSystem.symlink(
      path.join(repoRoot, "packages/client"),
      path.join(pluginNm, "@moltzap/client"),
    );
  });
}

function linkExtraSymlinks(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  pluginNm: string,
  specs: ReadonlyArray<PluginSymlinkSpec>,
): Effect.Effect<void, ChannelPluginInstallError | PlatformError> {
  return Effect.gen(function* () {
    for (const spec of specs) {
      const linkTarget = path.join(pluginNm, spec.linkPath);
      yield* fileSystem.makeDirectory(path.dirname(linkTarget), {
        recursive: true,
      });
      yield* symlinkPreferring(fileSystem, spec.candidates, linkTarget);
    }
  });
}

/**
 * Drop SpawnInput.workspaceFiles into `&lt;stateDir>/workspace/`. Identical
 * shape between adapters; lifted here so they share one implementation.
 */
export function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    if (workspaceFiles === undefined) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceDir = path.join(stateDir, "workspace");
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    for (const file of workspaceFiles) {
      const destination = path.join(workspaceDir, file.relativePath);
      yield* fileSystem.makeDirectory(path.dirname(destination), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(destination, file.content);
    }
  }).pipe(Effect.withSpan("seedWorkspaceFiles"));
}

function symlinkPreferring(
  fileSystem: FileSystem.FileSystem,
  candidates: ReadonlyArray<string>,
  target: string,
): Effect.Effect<void, ChannelPluginInstallError | PlatformError> {
  return Effect.gen(function* () {
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate);
      if (exists) {
        return yield* fileSystem.symlink(candidate, target);
      }
    }
    return yield* Effect.fail(
      new ChannelPluginInstallError({
        message: `channel-plugin-install: none of the candidate paths exist for ${target}: ${candidates.join(", ")}`,
      }),
    );
  });
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
    try {
      const requireFromAnchor = createRequire(anchor);
      const pkgJsonPath = requireFromAnchor.resolve(
        `${packageName}/package.json`,
      );
      return path.dirname(pkgJsonPath);
    } catch (resolveErr) {
      const code =
        resolveErr instanceof Error && "code" in resolveErr
          ? resolveErr.code
          : undefined;
      if (code !== "MODULE_NOT_FOUND") {
        yield* Effect.logWarning(
          "failed to resolve channel dependency",
          resolveErr,
        );
      }
      return null;
    }
  }).pipe(Effect.withSpan("resolveChannelDependency"));
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
