/** @file Installed production-router binary resolution. */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Data } from "effect";

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

/** What one candidate `package.json` lookup established. */
type PackageJsonCandidate =
  | { readonly _tag: "matched"; readonly root: string }
  | { readonly _tag: "absent" }
  | { readonly _tag: "unexpected"; readonly cause: unknown };

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPropertyRecord(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
): PackageJsonCandidate {
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromAnchor.resolve(candidate);
  } catch (cause) {
    return isExpectedResolutionFailure(cause)
      ? { _tag: "absent" }
      : { _tag: "unexpected", cause };
  }
  const packageRoot = dirname(packageJsonPath);
  try {
    const manifest = parsePackageJson(
      requireFromAnchor,
      packageRoot,
      packageName,
    );
    return manifest.name === packageName
      ? { _tag: "matched", root: packageRoot }
      : { _tag: "absent" };
  } catch (cause) {
    return { _tag: "unexpected", cause };
  }
}

/**
 * Candidates are tried nearest first: the package's own `package.json` export,
 * then each `node_modules` directory on the anchor's resolution path. Reading
 * the manifest by absolute path is what lets an `exports` map that hides
 * `./package.json` still be resolved.
 * @param anchor Module-resolution anchor.
 * @param packageName Package whose install root is wanted.
 * @returns The install root, or null when no candidate names the package.
 */
function resolvePackageRoot(
  anchor: string | URL,
  packageName: string,
): string | null {
  const requireFromAnchor = createRequire(anchor);
  const packageJsonCandidates = [
    `${packageName}/package.json`,
    ...(requireFromAnchor.resolve.paths(packageName) ?? []).map((lookupPath) =>
      join(lookupPath, packageName, "package.json"),
    ),
  ];
  let unexpectedCause: unknown = null;
  for (const candidate of packageJsonCandidates) {
    const resolution = resolvePackageJsonCandidate(
      requireFromAnchor,
      packageName,
      candidate,
    );
    if (resolution._tag === "matched") {
      return resolution.root;
    }
    if (resolution._tag === "unexpected") {
      unexpectedCause ??= resolution.cause;
    }
  }
  if (unexpectedCause !== null) {
    throw new PackageResolutionFailed({
      packageName,
      cause: unexpectedCause,
      message: `Unable to resolve package metadata for ${packageName}`,
    });
  }
  return null;
}

function resolveInstalledPackageRoot(
  packageName: string,
  anchor: string | URL,
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

function packageBinTarget(
  packageRoot: string,
  packageName: string,
  binName: string,
): string {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = parsePackageJson(
    createRequire(manifestPath),
    packageRoot,
    packageName,
  );
  const { bin } = manifest;
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
 * Resolve the installed production-router executable.
 * @param packageName Package owning the executable.
 * @param binName Declared package binary name.
 * @param anchor Module-resolution anchor, replaceable by deterministic tests.
 * @returns Absolute installed binary path.
 */
export function resolveInstalledPackageBin(
  packageName: string,
  binName: string,
  anchor: string | URL = PACKAGE_RESOLUTION_ANCHOR,
): string {
  return packageBinTarget(
    resolveInstalledPackageRoot(packageName, anchor),
    packageName,
    binName,
  );
}
