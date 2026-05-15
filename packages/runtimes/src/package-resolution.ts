import { createRequire } from "node:module";
import path from "node:path";
import { Data } from "effect";
import { existsSync, readFileStringSync } from "./node-fs.js";
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
  const packageJsonPath = path.join(packageRoot, "package.json");
  try {
    return JSON.parse(
      readFileStringSync(packageJsonPath, "utf8"),
    ) as PackageJson;
  } catch (cause) {
    throw new PackageResolutionFailed({
      packageName,
      cause,
      message: `Unable to read package.json for ${packageName} at ${packageJsonPath}`,
    });
  }
}

function packageRootFromResolvedFile(resolvedFile: string): string {
  let current = path.dirname(resolvedFile);
  while (current !== path.parse(current).root) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new PackageResolutionFailed({
    packageName: resolvedFile,
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
    return path.join(packageRoot, bin);
  }
  if (typeof bin === "object" && bin !== null && binName in bin) {
    const target = Object.entries(bin).find(([name]) => name === binName)?.[1];
    if (typeof target === "string") {
      return path.join(packageRoot, target);
    }
  }
  throw new PackageResolutionFailed({
    packageName,
    message: `Package ${packageName} does not expose bin ${binName}`,
  });
}

function resolveWorkspaceBin(input: WorkspaceBinInput): string {
  const packageLocalBin = path.join(
    input.workspacePackageRoot,
    "node_modules/.bin",
    input.binName,
  );
  if (existsSync(packageLocalBin)) {
    return packageLocalBin;
  }

  const repoBin = path.join(input.repoRoot, "node_modules/.bin", input.binName);
  if (existsSync(repoBin)) {
    return repoBin;
  }

  return packageBinTarget(input.packageRoot, input.packageName, input.binName);
}

function resolveOpenClawPackageRoot(): string {
  return packageRootFromResolvedFile(requireFromHere.resolve("openclaw"));
}

function resolveClaudeCodePackageRoot(): string {
  const packageName = claudeCodePackageJson.name;
  if (packageName !== "@anthropic-ai/claude-code") {
    throw new PackageResolutionFailed({
      packageName: "@anthropic-ai/claude-code",
      message: "Resolved Claude Code package metadata has an unexpected name",
    });
  }
  return path.dirname(
    requireFromHere.resolve("@anthropic-ai/claude-code/package.json"),
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
    return path.join(
      packageRootFromResolvedFile(
        requireFromHere.resolve("@moltzap/claude-code-channel"),
      ),
      "dist",
    );
  } catch (cause) {
    process.stderr.write(
      `failed to resolve @moltzap/claude-code-channel from package manager; falling back to workspace path: ${String(cause)}\n`,
    );
    return path.join(repoRoot, "packages/claude-code-channel/dist");
  }
}
