/**
 * Unit tests for the channel-plugin install helpers.
 *
 * Specifically guards the regression in moltzap#285: the OpenClaw adapter
 * used to assume runtime deps lived under `&lt;channelPackage>/dist/node_modules/`.
 * That layout only exists in some published artifacts; in workspace dev
 * mode `pnpm install` puts the dep at `&lt;channelPackage>/node_modules/` (or
 * hoists it to the repo root).
 *
 * `resolveChannelDependency` should walk Node's standard module resolution
 * starting from the channel package's `package.json`, so it finds the dep
 * whether it's per-package, hoisted to a parent `node_modules`, or any
 * other layout Node would normally walk to. None of those require
 * `dist/node_modules` to exist.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installChannelPlugin,
  resolveChannelDependency,
} from "./channel-plugin-install.js";

const OPENCLAW_CHANNEL_PACKAGE = "@moltzap/openclaw-channel";
const EFFECT_PACKAGE = "effect";
const FANCY_DEP_PACKAGE = "fancy-dep";
const LEGACY_DIST_NODE_MODULES = "dist/node_modules";
const NONEXISTENT_DEP_PACKAGE = "@moltzap/__nonexistent-dep-285__";
const CHANNEL_PACKAGE_DIR = "openclaw-channel";
const CHANNEL_EXTENSION_NAME = "openclaw-channel";

let workDir = "";

interface WorkspaceDependencyFixture {
  readonly repoRoot: string;
  readonly channelPkg: string;
  readonly channelDist: string;
  readonly channelDepDir: string;
  readonly stateDir: string;
}

beforeEach(() =>
  runWithNodeFileSystem(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) =>
        fileSystem.makeTempDirectory({
          prefix: "channel-plugin-install-",
        }),
      ),
      Effect.tap((directory) =>
        Effect.sync(() => {
          workDir = directory;
        }),
      ),
    ),
  ),
);

afterEach(() =>
  runWithNodeFileSystem(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) =>
        fileSystem.remove(workDir, { recursive: true, force: true }),
      ),
    ),
  ),
);

describe("resolveChannelDependency", () => {
  it(
    "resolves a dep installed at the channel package's own node_modules",
    resolvesOwnNodeModules,
  );
  it(
    "resolves a dep hoisted to a parent node_modules",
    resolvesHoistedDependency,
  );
  it(
    "returns null when the channel package has no package.json",
    missingPackageJsonReturnsNull,
  );
  it("returns null when the dep cannot be found", missingDependencyReturnsNull);
  it(
    "returns the package root for packages whose main lives under dist",
    resolvesPackageRoot,
  );
  it(
    "property: resolved dependency roots never point into legacy dist node_modules",
    resolvedRootsAvoidLegacyDistNodeModules,
  );
});

describe("installChannelPlugin", () => {
  it(
    "symlinks an extraSymlink dep from the workspace node_modules",
    symlinksWorkspaceDependency,
  );
});

function resolvesOwnNodeModules() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const channelPkg = path.join(workDir, CHANNEL_PACKAGE_DIR);
      const depPkg = path.join(channelPkg, "node_modules", EFFECT_PACKAGE);
      yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
      yield* seedPackage(depPkg, { name: EFFECT_PACKAGE, version: "3.21.0" });

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        EFFECT_PACKAGE,
      );

      expect(resolved).toBe(depPkg);
      expect(resolved).not.toContain(LEGACY_DIST_NODE_MODULES);
    }),
  );
}

function resolvesHoistedDependency() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const channelPkg = path.join(workDir, "packages", CHANNEL_PACKAGE_DIR);
      const hoistedDep = path.join(workDir, "node_modules", EFFECT_PACKAGE);
      yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
      yield* seedPackage(hoistedDep, {
        name: EFFECT_PACKAGE,
        version: "3.21.0",
      });

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        EFFECT_PACKAGE,
      );

      expect(resolved).toBe(hoistedDep);
    }),
  );
}

function missingPackageJsonReturnsNull() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const channelPkg = path.join(workDir, CHANNEL_PACKAGE_DIR);
      yield* fileSystem.makeDirectory(channelPkg, { recursive: true });

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        EFFECT_PACKAGE,
      );

      expect(resolved).toBeNull();
    }),
  );
}

function missingDependencyReturnsNull() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const channelPkg = path.join(workDir, CHANNEL_PACKAGE_DIR);
      yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        NONEXISTENT_DEP_PACKAGE,
      );

      expect(resolved).toBeNull();
    }),
  );
}

function resolvesPackageRoot() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const channelPkg = path.join(workDir, CHANNEL_PACKAGE_DIR);
      const depPkg = path.join(channelPkg, "node_modules", FANCY_DEP_PACKAGE);
      yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
      yield* seedPackage(depPkg, {
        name: FANCY_DEP_PACKAGE,
        version: "1.0.0",
        main: "dist/index.js",
      });

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        FANCY_DEP_PACKAGE,
      );

      expect(resolved).toBe(depPkg);
    }),
  );
}

function resolvedRootsAvoidLegacyDistNodeModules() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const roots = yield* Effect.all([
        resolveDependencyInOwnNodeModules(),
        resolveDependencyInHoistedNodeModules(),
      ]);

      for (const root of roots) {
        expect(root).not.toBeNull();
        expect(root).not.toContain(LEGACY_DIST_NODE_MODULES);
      }
    }),
  );
}

function resolveDependencyInOwnNodeModules() {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const channelPkg = path.join(workDir, "own", CHANNEL_PACKAGE_DIR);
    const depPkg = path.join(channelPkg, "node_modules", EFFECT_PACKAGE);
    yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
    yield* seedPackage(depPkg, { name: EFFECT_PACKAGE, version: "3.21.0" });
    return yield* resolveChannelDependency(channelPkg, EFFECT_PACKAGE);
  });
}

function resolveDependencyInHoistedNodeModules() {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.join(workDir, "hoisted");
    const channelPkg = path.join(root, "packages", CHANNEL_PACKAGE_DIR);
    const depPkg = path.join(root, "node_modules", EFFECT_PACKAGE);
    yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
    yield* seedPackage(depPkg, { name: EFFECT_PACKAGE, version: "3.21.0" });
    return yield* resolveChannelDependency(channelPkg, EFFECT_PACKAGE);
  });
}

function symlinksWorkspaceDependency() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fixture = yield* createWorkspaceDependencyFixture(workDir);

      const effectResolved = yield* resolveChannelDependency(
        fixture.channelPkg,
        EFFECT_PACKAGE,
      );
      expect(effectResolved).toBe(fixture.channelDepDir);

      const extDir = yield* installPluginUsingEffectDependency(
        fixture,
        effectResolved,
      );
      yield* assertEffectSymlinkTarget(extDir, fixture.channelDepDir);
    }),
  );
}

function createWorkspaceDependencyFixture(repoRoot: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const channelPkg = path.join(repoRoot, "packages", CHANNEL_PACKAGE_DIR);
    const channelDist = path.join(channelPkg, "dist");
    const channelDepDir = path.join(channelPkg, "node_modules", EFFECT_PACKAGE);
    const stateDir = path.join(repoRoot, ".state");

    yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
    yield* makeDirectory(channelDist);
    yield* writeTextFile(
      path.join(channelDist, "openclaw-entry.js"),
      "// stub\n",
    );
    yield* seedPackage(channelDepDir, {
      name: EFFECT_PACKAGE,
      version: "3.21.0",
    });
    yield* seedPackage(path.join(repoRoot, "packages", "protocol"), {
      name: "@moltzap/protocol",
    });
    yield* seedPackage(path.join(repoRoot, "packages", "client"), {
      name: "@moltzap/client",
    });
    yield* makeDirectory(stateDir);

    return { repoRoot, channelPkg, channelDist, channelDepDir, stateDir };
  });
}

function installPluginUsingEffectDependency(
  fixture: WorkspaceDependencyFixture,
  effectResolved: string | null,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* installChannelPlugin({
      stateDir: fixture.stateDir,
      channelDistDir: fixture.channelDist,
      repoRoot: fixture.repoRoot,
      extName: CHANNEL_EXTENSION_NAME,
      extraSymlinks: [
        {
          linkPath: EFFECT_PACKAGE,
          candidates: [
            ...(effectResolved === null ? [] : [effectResolved]),
            path.join(fixture.channelDist, "node_modules", EFFECT_PACKAGE),
          ],
        },
      ],
    });
  });
}

function assertEffectSymlinkTarget(extDir: string, expectedTarget: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const symlinkPath = path.join(extDir, "node_modules", EFFECT_PACKAGE);
    const linkTarget = yield* readLink(symlinkPath);
    expect(linkTarget).toBe(expectedTarget);
  });
}

function seedPackage(
  pkgDir: string,
  pkgJson: Readonly<Record<string, unknown>>,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* makeDirectory(pkgDir);
    yield* writeTextFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify(pkgJson, null, 2),
    );
  });
}

function makeDirectory(directory: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.makeDirectory(directory, { recursive: true }),
    ),
  );
}

function writeTextFile(filePath: string, content: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.writeFileString(filePath, content),
    ),
  );
}

function readLink(filePath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readLink(filePath)),
  );
}

function runWithNodeFileSystem<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));
}
