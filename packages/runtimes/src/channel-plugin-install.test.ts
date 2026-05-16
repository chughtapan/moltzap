/**
 * Unit tests for the channel-plugin install helpers.
 *
 * Specifically guards the regression in moltzap#285: the OpenClaw adapter
 * used to assume runtime deps lived under `<channelPackage>/dist/node_modules/`.
 * That layout only exists in some published artifacts; in workspace dev
 * mode `pnpm install` puts the dep at `<channelPackage>/node_modules/` (or
 * hoists it to the repo root).
 *
 * `resolveChannelDependency` should walk Node's standard module resolution
 * starting from the channel package's `package.json`, so it finds the dep
 * whether it's per-package, hoisted to a parent `node_modules`, or any
 * other layout Node would normally walk to — none of which require
 * `dist/node_modules` to exist.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installChannelPlugin,
  resolveChannelDependency,
} from "./channel-plugin-install.js";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-plugin-install-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("resolveChannelDependency", () => {
  it("resolves a dep installed at the channel package's own node_modules (no dist/node_modules required)", async () => {
    const channelPkg = path.join(workDir, "openclaw-channel");
    const depPkg = path.join(channelPkg, "node_modules", "effect");
    seedPackage(channelPkg, { name: "@moltzap/openclaw-channel" });
    seedPackage(depPkg, { name: "effect", version: "3.21.0" });

    const resolved = await runWithNodeFileSystem(
      resolveChannelDependency(channelPkg, "effect"),
    );

    expect(resolved).toBe(depPkg);
    expect(resolved).not.toContain("dist/node_modules");
  });

  it("resolves a dep hoisted to a parent (workspace-root) node_modules", async () => {
    const channelPkg = path.join(workDir, "packages", "openclaw-channel");
    const hoistedDep = path.join(workDir, "node_modules", "effect");
    seedPackage(channelPkg, { name: "@moltzap/openclaw-channel" });
    seedPackage(hoistedDep, { name: "effect", version: "3.21.0" });

    const resolved = await runWithNodeFileSystem(
      resolveChannelDependency(channelPkg, "effect"),
    );

    expect(resolved).toBe(hoistedDep);
  });

  it("returns null when the channel package has no package.json", async () => {
    const channelPkg = path.join(workDir, "openclaw-channel");
    fs.mkdirSync(channelPkg, { recursive: true });
    await expect(
      runWithNodeFileSystem(resolveChannelDependency(channelPkg, "effect")),
    ).resolves.toBeNull();
  });

  it("returns null when the dep cannot be found anywhere in the resolution chain", async () => {
    const channelPkg = path.join(workDir, "openclaw-channel");
    seedPackage(channelPkg, { name: "@moltzap/openclaw-channel" });
    // A purposefully-improbable scoped name keeps Node's parent-walking
    // resolution from accidentally finding a real install (workDir lives
    // under `/tmp`, which on dev machines can sit beneath populated
    // node_modules trees).
    await expect(
      runWithNodeFileSystem(
        resolveChannelDependency(
          channelPkg,
          "@moltzap/__nonexistent-dep-285__",
        ),
      ),
    ).resolves.toBeNull();
  });

  it("returns the package root (not a dist subpath) for packages whose main lives under dist/", async () => {
    const channelPkg = path.join(workDir, "openclaw-channel");
    const depPkg = path.join(channelPkg, "node_modules", "fancy-dep");
    seedPackage(channelPkg, { name: "@moltzap/openclaw-channel" });
    seedPackage(depPkg, {
      name: "fancy-dep",
      version: "1.0.0",
      main: "dist/index.js",
    });

    const resolved = await runWithNodeFileSystem(
      resolveChannelDependency(channelPkg, "fancy-dep"),
    );

    expect(resolved).toBe(depPkg);
  });
});

describe("installChannelPlugin (workspace layout, no dist/node_modules)", () => {
  it("symlinks an extraSymlink dep from the workspace node_modules when dist/node_modules is absent", async () => {
    // Mirror real workspace layout: a channel package with its built dist/
    // and a sibling node_modules containing the runtime dep — exactly the
    // shape `pnpm install --frozen-lockfile && pnpm -r build` produces and
    // the shape that triggered #285.
    const repoRoot = workDir;
    const channelPkg = path.join(repoRoot, "packages", "openclaw-channel");
    const channelDist = path.join(channelPkg, "dist");
    const channelDepDir = path.join(channelPkg, "node_modules", "effect");
    const protocolPkg = path.join(repoRoot, "packages", "protocol");
    const clientPkg = path.join(repoRoot, "packages", "client");
    const stateDir = path.join(repoRoot, ".state");

    seedPackage(channelPkg, { name: "@moltzap/openclaw-channel" });
    fs.mkdirSync(channelDist, { recursive: true });
    fs.writeFileSync(path.join(channelDist, "openclaw-entry.js"), "// stub\n");
    seedPackage(channelDepDir, { name: "effect", version: "3.21.0" });
    seedPackage(protocolPkg, { name: "@moltzap/protocol" });
    seedPackage(clientPkg, { name: "@moltzap/client" });
    fs.mkdirSync(stateDir, { recursive: true });

    const channelPackageDir = path.dirname(channelDist);
    const effectResolved = await runWithNodeFileSystem(
      resolveChannelDependency(channelPackageDir, "effect"),
    );
    expect(effectResolved).toBe(channelDepDir);

    const extDir = await runWithNodeFileSystem(
      installChannelPlugin({
        stateDir,
        channelDistDir: channelDist,
        repoRoot,
        extName: "openclaw-channel",
        extraSymlinks: [
          {
            linkPath: "effect",
            candidates: [
              ...(effectResolved === null ? [] : [effectResolved]),
              // Legacy fallback path that does NOT exist in this layout —
              // kept here intentionally so the test proves the resolver
              // candidate wins over the bundled fallback.
              path.join(channelDist, "node_modules", "effect"),
            ],
          },
        ],
      }),
    );

    const symlinkPath = path.join(extDir, "node_modules", "effect");
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(channelDepDir);
  });
});

function seedPackage(
  pkgDir: string,
  pkgJson: Readonly<Record<string, unknown>>,
): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );
}

function runWithNodeFileSystem<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));
}
