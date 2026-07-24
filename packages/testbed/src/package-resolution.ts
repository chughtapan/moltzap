import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { Data } from "effect";

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_RESOLUTION_ANCHOR = import.meta.url;

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
}

interface PackageJsonResolution {
  readonly rejectedRoots: ReadonlySet<string>;
  readonly root: string | null;
  readonly unexpectedCause: unknown | null;
}

interface PackageJsonCandidateResolution {
  readonly rejectedRoot: string | null;
  readonly root: string | null;
  readonly unexpectedCause: unknown | null;
}

function parsePackageJson(
  requireFromAnchor: NodeRequire,
  packageRoot: string,
  packageName: string,
): PackageJson {
  const packageJsonPath = join(packageRoot, "package.json");
  try {
    return requireFromAnchor(packageJsonPath) as PackageJson;
  } catch (cause) {
    throw new PackageResolutionFailed({
      packageName,
      cause,
      message: `Unable to read package.json for ${packageName} at ${packageJsonPath}`,
    });
  }
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
  requireFromAnchor: NodeRequire,
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
  requireFromAnchor: NodeRequire,
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
      throw packageJsonResolution.unexpectedCause;
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
  if (typeof bin === "object" && bin !== null && binName in bin) {
    const target = Object.entries(bin).find(([name]) => name === binName)?.[1];
    if (typeof target === "string") {
      return join(packageRoot, target);
    }
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Package ${packageName} does not expose bin ${binName}`,
  });
}

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
