import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type InstallMode, makeInstallModeResolver } from "./install-mode.js";

const WORKSPACE_PACKAGES_DIR = join("/workspace", "packages");
const WORKSPACE_CHANNEL_ROOT = join(WORKSPACE_PACKAGES_DIR, "openclaw-channel");
const INSTALLED_CHANNEL_ROOT = join(
  "/consumer",
  "node_modules",
  "@moltzap",
  "openclaw-channel",
);

interface DecisionCase {
  readonly expected: InstallMode;
  readonly explicit?: InstallMode;
  readonly packageRoot: string;
  readonly title: string;
}

const DECISION_CASES: ReadonlyArray<DecisionCase> = [
  {
    title: "infers workspace from a workspace package root",
    packageRoot: WORKSPACE_CHANNEL_ROOT,
    expected: "workspace",
  },
  {
    title: "infers published from an installed node_modules root",
    packageRoot: INSTALLED_CHANNEL_ROOT,
    expected: "published",
  },
  {
    title: "lets a published override beat workspace inference",
    explicit: "published",
    packageRoot: WORKSPACE_CHANNEL_ROOT,
    expected: "published",
  },
  {
    title: "lets a workspace override beat published inference",
    explicit: "workspace",
    packageRoot: INSTALLED_CHANNEL_ROOT,
    expected: "workspace",
  },
];

describe("resolveInstallMode", () => {
  it.each(DECISION_CASES)("$title", ({ expected, explicit, packageRoot }) => {
    const resolveChannelPackageRoot = vi.fn(() => packageRoot);
    const resolve = makeInstallModeResolver({
      resolveChannelPackageRoot,
      workspacePackagesDir: WORKSPACE_PACKAGES_DIR,
    });

    const mode = Effect.runSync(resolve(explicit));

    expect(mode).toBe(expected);
    expect(resolveChannelPackageRoot).toHaveBeenCalledTimes(
      explicit === undefined ? 1 : 0,
    );
  });
});
