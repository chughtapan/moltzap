import { createRequire } from "node:module";
import { Path } from "@effect/platform";
import { Data, Effect } from "effect";
import claudeCodePackageJson from "@anthropic-ai/claude-code/package.json" with { type: "json" };

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

interface WorkspaceBinInput {
  readonly binName: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly repoRoot: string;
  readonly workspacePackageRoot: string;
}

function parsePackageJson(
  packageRoot: string,
  packageName: string,
): PackageJson {
  const packageJsonPath = pathSync((path) =>
    path.join(packageRoot, "package.json"),
  );
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
  const separator = pathSync((path) => path.sep);
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
    return pathSync((path) => path.join(packageRoot, bin));
  }
  if (typeof bin === "object" && bin !== null && binName in bin) {
    const target = Object.entries(bin).find(([name]) => name === binName)?.[1];
    if (typeof target === "string") {
      return pathSync((path) => path.join(packageRoot, target));
    }
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Package ${packageName} does not expose bin ${binName}`,
  });
}

function resolveWorkspaceBin(input: WorkspaceBinInput): string {
  const requireFromWorkspace = createRequire(
    pathSync((path) => path.join(input.workspacePackageRoot, "package.json")),
  );
  try {
    const resolvedFile = requireFromWorkspace.resolve(input.packageName);
    return packageBinTarget(
      packageRootFromResolvedFile(input.packageName, resolvedFile),
      input.packageName,
      input.binName,
    );
  } catch (resolveErr) {
    logWarningSync(
      `failed to resolve ${input.packageName} from workspace package; falling back to dependency root`,
      resolveErr,
    );
    return packageBinTarget(
      input.packageRoot,
      input.packageName,
      input.binName,
    );
  }
}

function resolveOpenClawPackageRoot(): string {
  return packageRootFromResolvedFile(
    "openclaw",
    requireFromHere.resolve("openclaw"),
  );
}

function resolveClaudeCodePackageRoot(): string {
  const packageName = claudeCodePackageJson.name;
  if (packageName !== "@anthropic-ai/claude-code") {
    throw new PackageResolutionFailed({
      packageName: "@anthropic-ai/claude-code",
      message: "Resolved Claude Code package metadata has an unexpected name",
    });
  }
  return pathSync((path) =>
    path.dirname(
      requireFromHere.resolve("@anthropic-ai/claude-code/package.json"),
    ),
  );
}

export function resolveWorkspaceOpenClawBin(input: {
  readonly repoRoot: string;
  readonly workspacePackageRoot: string;
}): string {
  return resolveWorkspaceBin({
    ...input,
    binName: "openclaw",
    packageName: "openclaw",
    packageRoot: resolveOpenClawPackageRoot(),
  });
}

export function resolveWorkspaceClaudeBin(input: {
  readonly repoRoot: string;
  readonly workspacePackageRoot: string;
}): string {
  return resolveWorkspaceBin({
    ...input,
    binName: "claude",
    packageName: "@anthropic-ai/claude-code",
    packageRoot: resolveClaudeCodePackageRoot(),
  });
}

export function resolveClaudeCodeChannelDistDir(repoRoot: string): string {
  try {
    return pathSync((path) =>
      path.join(
        packageRootFromResolvedFile(
          "@moltzap/claude-code-channel",
          requireFromHere.resolve("@moltzap/claude-code-channel"),
        ),
        "dist",
      ),
    );
  } catch (cause) {
    logWarningSync(
      "failed to resolve @moltzap/claude-code-channel from package manager; falling back to workspace path",
      cause,
    );
    return pathSync((path) =>
      path.join(repoRoot, "packages/claude-code-channel/dist"),
    );
  }
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
}

function logWarningSync(message: string, cause: unknown): void {
  Effect.runSync(Effect.logWarning(message, cause));
}
