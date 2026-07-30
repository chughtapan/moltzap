/** @file Installed-package resolution and runtime artifact selection. */

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Node package ownership follows createRequire synchronously; this is the module-resolution boundary, not filesystem application logic.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Schema } from "effect";

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_RESOLUTION_ANCHOR = import.meta.url;
const VERSION_NUMBER_PATTERN = /^(?:0|[1-9]\d*)$/;
const VERSION_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;

class PackageResolutionFailed extends Data.TaggedError(
  "PackageResolutionFailed",
)<{
  readonly message: string;
  readonly packageName: string;
  readonly cause?: unknown;
}> {}

interface PackageJson {
  readonly name?: unknown;
  readonly bin?: unknown;
  readonly dependencies?: unknown;
  readonly version?: unknown;
}

interface PackageJsonResolution {
  readonly rejectedRoots: ReadonlySet<string>;
  readonly root: string | null;
  readonly unexpectedCause: unknown;
}

interface PackageJsonCandidateResolution {
  readonly rejectedRoot: string | null;
  readonly root: string | null;
  readonly unexpectedCause: unknown;
}

interface OwningPackage {
  readonly manifest: PackageJson;
  readonly root: string;
}

/** Describes installed package dependency. */
export interface InstalledPackageDependency {
  readonly ownerPackageRoot: string;
  readonly declaredSpec: string;
  readonly packageRoot: string;
  readonly version: string;
}

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPropertyRecord(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitAtFirst(
  value: string,
  separator: string,
): readonly [string, string | null] {
  const separatorIndex = value.indexOf(separator);
  if (separatorIndex < 0) {
    return [value, null];
  }
  return [
    value.slice(0, separatorIndex),
    value.slice(separatorIndex + separator.length),
  ];
}

function isValidPrerelease(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return value.split(".").every((identifier) => {
    if (!VERSION_IDENTIFIER_PATTERN.test(identifier)) {
      return false;
    }
    return /^\d+$/.test(identifier)
      ? VERSION_NUMBER_PATTERN.test(identifier)
      : true;
  });
}

function isValidBuild(value: string): boolean {
  return (
    value.length > 0 &&
    value
      .split(".")
      .every((identifier) => VERSION_IDENTIFIER_PATTERN.test(identifier))
  );
}

function isExactPackageVersion(version: string): boolean {
  const [withoutBuild, build] = splitAtFirst(version, "+");
  if (build !== null && !isValidBuild(build)) {
    return false;
  }
  const [core, prerelease] = splitAtFirst(withoutBuild, "-");
  if (prerelease !== null && !isValidPrerelease(prerelease)) {
    return false;
  }
  const coreIdentifiers = core.split(".");
  return (
    coreIdentifiers.length === 3 &&
    coreIdentifiers.every((identifier) =>
      VERSION_NUMBER_PATTERN.test(identifier),
    )
  );
}

function parsePackageJson(
  requireFromAnchor: NodeJS.Require,
  packageRoot: string,
  packageName: string,
): PackageJson {
  const packageJsonPath = join(packageRoot, "package.json");
  let manifest: unknown;
  try {
    manifest = requireFromAnchor(packageJsonPath);
  } catch (cause) {
    throw new PackageResolutionFailed({
      packageName,
      cause,
      message: `Unable to read package.json for ${packageName} at ${packageJsonPath}`,
    });
  }
  if (!isPackageJson(manifest)) {
    throw new PackageResolutionFailed({
      packageName,
      message: `Invalid package.json for ${packageName} at ${packageJsonPath}: expected an object`,
    });
  }
  return manifest;
}

function packageRootFromResolvedFile(
  packageName: string,
  resolvedFile: string,
): string {
  const packageSegments = packageName.split("/");
  const separator = sep;
  const resolvedSegments = resolvedFile.split(separator);
  for (
    let index = resolvedSegments.length - packageSegments.length;
    index >= 0;
    index--
  ) {
    if (
      packageSegments.every(
        (segment, offset) => resolvedSegments[index + offset] === segment,
      )
    ) {
      return resolvedSegments
        .slice(0, index + packageSegments.length)
        .join(separator);
    }
  }
  const packageBaseName = packageSegments.at(-1);
  if (packageBaseName !== undefined) {
    const packageIndex = resolvedSegments.lastIndexOf(packageBaseName);
    if (packageIndex >= 0) {
      return resolvedSegments.slice(0, packageIndex + 1).join(separator);
    }
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Unable to find package root for ${resolvedFile}`,
  });
}

function isExpectedResolutionFailure(cause: unknown): boolean {
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  return (
    code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );
}

function resolvePackageJsonCandidate(
  requireFromAnchor: NodeJS.Require,
  packageName: string,
  candidate: string,
): PackageJsonCandidateResolution {
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromAnchor.resolve(candidate);
  } catch (cause) {
    return {
      rejectedRoot: null,
      root: null,
      unexpectedCause: isExpectedResolutionFailure(cause) ? null : cause,
    };
  }
  const packageRoot = dirname(packageJsonPath);
  try {
    const manifest = parsePackageJson(
      requireFromAnchor,
      packageRoot,
      packageName,
    );
    return manifest.name === packageName
      ? { rejectedRoot: null, root: packageRoot, unexpectedCause: null }
      : { rejectedRoot: packageRoot, root: null, unexpectedCause: null };
  } catch (cause) {
    return {
      rejectedRoot: packageRoot,
      root: null,
      unexpectedCause: cause,
    };
  }
}

function resolvePackageJson(
  requireFromAnchor: NodeJS.Require,
  packageName: string,
): PackageJsonResolution {
  const packageJsonCandidates = [
    `${packageName}/package.json`,
    ...(requireFromAnchor.resolve.paths(packageName) ?? []).map((lookupPath) =>
      join(lookupPath, packageName, "package.json"),
    ),
  ];
  const rejectedRoots = new Set<string>();
  let unexpectedCause: unknown = null;
  for (const candidate of packageJsonCandidates) {
    const resolution = resolvePackageJsonCandidate(
      requireFromAnchor,
      packageName,
      candidate,
    );
    if (resolution.root !== null) {
      return { rejectedRoots, root: resolution.root, unexpectedCause: null };
    }
    if (resolution.rejectedRoot !== null) {
      rejectedRoots.add(resolution.rejectedRoot);
    }
    unexpectedCause ??= resolution.unexpectedCause;
  }
  return { rejectedRoots, root: null, unexpectedCause };
}

/**
 * Resolves a package root from the same module-resolution context as `anchor`.
 *
 * A package may hide `package.json` behind its exports map, so lookup-path
 * candidates precede recovery from the package's public entry point.
 * @param anchor Value supplied to the operation.
 * @param packageName Value supplied to the operation.
 * @returns The resolve package root result.
 */
export function resolvePackageRoot(
  anchor: string | URL,
  packageName: string,
): string | null {
  const requireFromAnchor = createRequire(anchor);
  const packageJsonResolution = resolvePackageJson(
    requireFromAnchor,
    packageName,
  );
  if (packageJsonResolution.root !== null) {
    return packageJsonResolution.root;
  }
  try {
    const publicEntryRoot = packageRootFromResolvedFile(
      packageName,
      requireFromAnchor.resolve(packageName),
    );
    return packageJsonResolution.rejectedRoots.has(publicEntryRoot)
      ? null
      : publicEntryRoot;
  } catch (cause) {
    if (!isExpectedResolutionFailure(cause)) {
      throw cause;
    }
    if (packageJsonResolution.unexpectedCause !== null) {
      throw new PackageResolutionFailed({
        packageName,
        cause: packageJsonResolution.unexpectedCause,
        message: `Unable to resolve package metadata for ${packageName}`,
      });
    }
    return null;
  }
}

function packageBinTarget(
  packageRoot: string,
  packageName: string,
  binName: string,
): string {
  const packageJson = parsePackageJson(
    requireFromHere,
    packageRoot,
    packageName,
  );
  const { bin } = packageJson;
  if (typeof bin === "string") {
    return join(packageRoot, bin);
  }
  if (isPropertyRecord(bin)) {
    const target = bin[binName];
    if (typeof target === "string") {
      return join(packageRoot, target);
    }
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Package ${packageName} does not expose bin ${binName}`,
  });
}

/**
 * Resolves installed package root.
 * @param packageName Value supplied to the operation.
 * @param anchor Value supplied to the operation.
 * @returns The resolve installed package root result.
 */
export function resolveInstalledPackageRoot(
  packageName: string,
  anchor: string | URL = PACKAGE_RESOLUTION_ANCHOR,
): string {
  try {
    const packageRoot = resolvePackageRoot(anchor, packageName);
    if (packageRoot !== null) {
      return packageRoot;
    }
  } catch (cause) {
    if (cause instanceof PackageResolutionFailed) {
      throw cause;
    }
    throw new PackageResolutionFailed({
      packageName,
      cause,
      message: `Unable to resolve installed package ${packageName}`,
    });
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Unable to resolve installed package ${packageName}`,
  });
}

function anchorFilePath(anchor: string | URL, packageName: string): string {
  try {
    const path =
      typeof anchor === "string" && !anchor.startsWith("file:")
        ? anchor
        : fileURLToPath(anchor);
    return resolve(path);
  } catch (cause) {
    throw new PackageResolutionFailed({
      packageName,
      cause,
      message: `Unable to interpret package-resolution anchor ${String(anchor)}`,
    });
  }
}

function findOwningPackage(
  ownerPackageName: string,
  anchor: string | URL,
): OwningPackage {
  const anchorPath = anchorFilePath(anchor, ownerPackageName);
  let candidateRoot = dirname(anchorPath);
  while (true) {
    const manifestPath = join(candidateRoot, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = parsePackageJson(
        createRequire(manifestPath),
        candidateRoot,
        ownerPackageName,
      );
      if (manifest.name !== ownerPackageName) {
        throw new PackageResolutionFailed({
          packageName: ownerPackageName,
          message: `Package-resolution anchor ${anchorPath} belongs to ${String(manifest.name)}, not ${ownerPackageName}`,
        });
      }
      return { manifest, root: candidateRoot };
    }
    const parent = dirname(candidateRoot);
    if (parent === candidateRoot) {
      throw new PackageResolutionFailed({
        packageName: ownerPackageName,
        message: `Unable to find owning package ${ownerPackageName} from ${anchorPath}`,
      });
    }
    candidateRoot = parent;
  }
}

/**
 * Locate the package that owns a module anchor.
 *
 * Runtime assets use package ownership rather than source-file depth, so
 * moving compiled modules cannot change which package artifact they read.
 * @param ownerPackageName Value supplied to the operation.
 * @param anchor Value supplied to the operation.
 * @internal
 * @returns The resolve owning package root result.
 */
export function resolveOwningPackageRoot(
  ownerPackageName: string,
  anchor: string | URL,
): string {
  return findOwningPackage(ownerPackageName, anchor).root;
}

function ownDependencySpec(
  ownerPackageName: string,
  ownerPackageRoot: string,
  manifest: PackageJson,
  dependencyName: string,
): string {
  const dependencies = manifest.dependencies;
  if (
    !Object.hasOwn(manifest, "dependencies") ||
    !isPropertyRecord(dependencies)
  ) {
    throw new PackageResolutionFailed({
      packageName: dependencyName,
      message: `Package ${ownerPackageName} at ${ownerPackageRoot} must declare ${dependencyName} in its own dependencies`,
    });
  }
  if (!Object.hasOwn(dependencies, dependencyName)) {
    throw new PackageResolutionFailed({
      packageName: dependencyName,
      message: `Package ${ownerPackageName} at ${ownerPackageRoot} must declare ${dependencyName} in its own dependencies`,
    });
  }
  const declaredSpec = dependencies[dependencyName];
  if (typeof declaredSpec !== "string" || declaredSpec.length === 0) {
    throw new PackageResolutionFailed({
      packageName: dependencyName,
      message: `Package ${ownerPackageName} at ${ownerPackageRoot} has an invalid dependencies declaration for ${dependencyName}`,
    });
  }
  return declaredSpec;
}

/**
 * Resolves one of an owning package's runtime dependencies and reports both
 * the declared install contract and the exact installed artifact.
 *
 * Reading from the owner's manifest anchor prevents a nested caller path from
 * changing which installed dependency Node selects.
 * @param ownerPackageName Value supplied to the operation.
 * @param dependencyName Value supplied to the operation.
 * @param anchor Value supplied to the operation.
 * @returns The resolve installed package dependency result.
 */
export function resolveInstalledPackageDependency(
  ownerPackageName: string,
  dependencyName: string,
  anchor: string | URL = PACKAGE_RESOLUTION_ANCHOR,
): InstalledPackageDependency {
  const owner = findOwningPackage(ownerPackageName, anchor);
  const declaredSpec = ownDependencySpec(
    ownerPackageName,
    owner.root,
    owner.manifest,
    dependencyName,
  );
  const ownerManifestPath = join(owner.root, "package.json");
  const packageRoot = resolveInstalledPackageRoot(
    dependencyName,
    ownerManifestPath,
  );
  const installedManifest = parsePackageJson(
    createRequire(ownerManifestPath),
    packageRoot,
    dependencyName,
  );
  if (installedManifest.name !== dependencyName) {
    throw new PackageResolutionFailed({
      packageName: dependencyName,
      message: `Installed package at ${packageRoot} is named ${String(installedManifest.name)}, not ${dependencyName}`,
    });
  }
  if (
    typeof installedManifest.version !== "string" ||
    !isExactPackageVersion(installedManifest.version)
  ) {
    throw new PackageResolutionFailed({
      packageName: dependencyName,
      message: `Installed package ${dependencyName} at ${packageRoot} does not declare an exact version`,
    });
  }
  return {
    ownerPackageRoot: owner.root,
    declaredSpec,
    packageRoot,
    version: installedManifest.version,
  };
}

/**
 * Resolves installed package bin.
 * @param packageName Value supplied to the operation.
 * @param binName Value supplied to the operation.
 * @returns The resolve installed package bin result.
 */
export function resolveInstalledPackageBin(
  packageName: string,
  binName: string,
): string {
  return packageBinTarget(
    resolveInstalledPackageRoot(packageName),
    packageName,
    binName,
  );
}

/** Represents install mode values. */
export type InstallMode = "published" | "workspace";

const CHANNEL_PACKAGE_NAME = "@moltzap/openclaw-channel";

/** Runtime package placement could not be determined. */
export class RuntimePackageError extends Schema.TaggedError<RuntimePackageError>()(
  "RuntimePackageError",
  {
    detail: Schema.String,
  },
) {}

interface InstallModeResolverDeps {
  readonly resolveChannelPackageRoot: () => string;
  readonly workspacePackagesDir: string | null;
}

interface InstallModeDecision {
  readonly determinedBy: "explicit override" | "package resolution";
  readonly mode: InstallMode;
  readonly packageRoot: string | null;
}

const defaultResolverDeps: InstallModeResolverDeps = {
  resolveChannelPackageRoot: () =>
    resolveInstalledPackageRoot(CHANNEL_PACKAGE_NAME, import.meta.url),
  workspacePackagesDir: findWorkspacePackagesDir(import.meta.url),
};

/**
 * Build an install-mode resolver around explicit package-location seams.
 * @param deps Value supplied to the operation.
 * @returns The created install mode resolver.
 */
export function makeInstallModeResolver(deps: InstallModeResolverDeps) {
  return (installMode?: InstallMode) =>
    Effect.try({
      try: () => decideInstallMode(deps, installMode),
      catch: (cause) =>
        RuntimePackageError.make({
          detail: `Could not resolve the OpenClaw channel package location: ${String(cause)}`,
        }),
    }).pipe(
      Effect.tap(logInstallModeDecision),
      Effect.map((decision) => decision.mode),
    );
}

/**
 * Select workspace sources or exact installed packages for one runtime.
 * @param installMode Value supplied to the operation.
 * @returns The resolve install mode result.
 */
export function resolveInstallMode(installMode?: InstallMode) {
  return makeInstallModeResolver(defaultResolverDeps)(installMode);
}

function decideInstallMode(
  deps: InstallModeResolverDeps,
  installMode?: InstallMode,
): InstallModeDecision {
  if (installMode !== undefined) {
    return {
      determinedBy: "explicit override",
      mode: installMode,
      packageRoot: null,
    };
  }
  const packageRoot = deps.resolveChannelPackageRoot();
  return {
    determinedBy: "package resolution",
    mode: isWorkspacePackageRoot(packageRoot, deps.workspacePackagesDir)
      ? "workspace"
      : "published",
    packageRoot,
  };
}

function logInstallModeDecision(decision: InstallModeDecision) {
  return Effect.logInfo("resolved runtime install mode").pipe(
    Effect.annotateLogs({
      installMode: decision.mode,
      determinedBy: decision.determinedBy,
      ...(decision.packageRoot === null
        ? {}
        : { packageRoot: decision.packageRoot }),
    }),
  );
}

function isWorkspacePackageRoot(
  packageRoot: string,
  workspacePackagesDir: string | null,
): boolean {
  if (workspacePackagesDir === null) {
    return false;
  }
  const relativeRoot = relative(workspacePackagesDir, packageRoot);
  if (
    relativeRoot === "" ||
    relativeRoot === ".." ||
    relativeRoot.startsWith(".." + sep) ||
    isAbsolute(relativeRoot)
  ) {
    return false;
  }
  return !relativeRoot.split(sep).includes("node_modules");
}

/**
 * Find the workspace package directory containing the simulator package.
 * @param moduleUrl Value supplied to the operation.
 * @returns The find workspace packages dir result.
 */
export function findWorkspacePackagesDir(
  moduleUrl: string | URL,
): string | null {
  let current = dirname(fileURLToPath(moduleUrl));
  const root = parse(current).root;
  while (current !== root) {
    const parent = dirname(current);
    if (basename(current) === "simulator" && basename(parent) === "packages") {
      return parent;
    }
    current = parent;
  }
  return null;
}
