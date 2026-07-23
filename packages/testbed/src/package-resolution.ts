import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { Data, Option } from "effect";

const requireFromHere = createRequire(import.meta.url);

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

function parsePackageJson(
  packageRoot: string,
  packageName: string,
): PackageJson {
  const packageJsonPath = join(packageRoot, "package.json");
  try {
    return requireFromHere(packageJsonPath) as PackageJson;
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

function packageBinTarget(
  packageRoot: string,
  packageName: string,
  binName: string,
): string {
  const packageJson = parsePackageJson(packageRoot, packageName);
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
  lookupPaths: readonly string[] = requireFromHere.resolve.paths(packageName) ??
    [],
): string {
  for (const lookupPath of lookupPaths) {
    const packageRoot = join(lookupPath, packageName);
    const manifest = Option.liftThrowable(parsePackageJson)(
      packageRoot,
      packageName,
    );
    if (Option.isSome(manifest) && manifest.value.name === packageName) {
      return packageRoot;
    }
  }
  return packageRootFromResolvedFile(
    packageName,
    requireFromHere.resolve(packageName),
  );
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
