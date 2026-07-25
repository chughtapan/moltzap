import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, parse, relative, sep } from "node:path";
import { Effect } from "effect";
import { resolveInstalledPackageRoot } from "./package-resolution.js";

export type InstallMode = "published" | "workspace";

const CHANNEL_PACKAGE_NAME = "@moltzap/openclaw-channel";

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
 * Builds a resolver around explicit package-location seams so inference stays
 * testable without depending on the checkout that runs the test.
 * @internal
 */
export function makeInstallModeResolver(deps: InstallModeResolverDeps) {
  return (installMode?: InstallMode) =>
    Effect.sync(() => decideInstallMode(deps, installMode)).pipe(
      Effect.tap(logInstallModeDecision),
      Effect.map((decision) => decision.mode),
    );
}

/**
 * Resolves and logs the artifact column selected for one testbed. This is the
 * only place the mode is inferred; adapters receive an already-decided mode so
 * a resolution failure stays in the launching Effect's error channel.
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
  return Effect.logInfo("resolved testbed install mode").pipe(
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
  if (workspacePackagesDir === null) return false;
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

/** @internal */
export function findWorkspacePackagesDir(
  moduleUrl: string | URL,
): string | null {
  let current = dirname(fileURLToPath(moduleUrl));
  const root = parse(current).root;
  while (current !== root) {
    const parent = dirname(current);
    if (basename(current) === "testbed" && basename(parent) === "packages") {
      return parent;
    }
    current = parent;
  }
  return null;
}
