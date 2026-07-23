/**
 * Unit tests for the channel-plugin install helpers.
 *
 * `resolveChannelDependency` should walk Node's standard module resolution
 * starting from the channel package's `package.json`, so it finds the dep
 * whether it is package-local, hoisted, or hidden behind an export map.
 * Installed plugins link every declared runtime dependency from that
 * resolution chain.
 */
import { pathToFileURL } from "node:url";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Option } from "effect";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installChannelPlugin,
  resolveChannelDependency,
  seedWorkspaceFiles,
  serializeMoltZapProfileConfig,
  TESTBED_PROFILE_NAME,
  writeMoltZapProfileConfig,
} from "./channel-plugin-install.js";

const OPENCLAW_CHANNEL_PACKAGE = "@moltzap/openclaw-channel";
const CLIENT_PACKAGE = "@moltzap/client";
const PROTOCOL_PACKAGE = "@moltzap/protocol";
const EFFECT_PACKAGE = "effect";
const EFFECT_PLATFORM_PACKAGE = "@effect/platform";
const EFFECT_PLATFORM_NODE_PACKAGE = "@effect/platform-node";
const FANCY_DEP_PACKAGE = "fancy-dep";
const LEGACY_DIST_NODE_MODULES = "dist/node_modules";
const NONEXISTENT_DEP_PACKAGE = "@moltzap/__nonexistent-dep-285__";
const CHANNEL_PACKAGE_DIR = "openclaw-channel";
const CHANNEL_EXTENSION_NAME = "openclaw-channel";
const CHANNEL_ENTRY_FILE = "openclaw-entry.js";
const PROFILE_CONFIG_FILE_NAME = "config.json";
const PROFILE_FILE_PERMISSION_MASK = 0o777;
const PROFILE_FILE_MODE = 0o600;
const NPM_FIXTURE_TIMEOUT_MS = 15_000;
const TEST_AGENT_NAME = "network-agent";
const WORKSPACE_FILE_CONTENT = "review";
const WORKSPACE_FILE_PATH = "skills/reviewer.md";
const TEST_AGENT_ID = agentId("11111111-1111-4111-8111-111111111111");
const TEST_AGENT_KEY_TEXT = agentKeyString(29);
const TEST_AGENT_KEY = redactedAgentKey(TEST_AGENT_KEY_TEXT);
const CHANNEL_DEPENDENCIES = [
  EFFECT_PLATFORM_PACKAGE,
  EFFECT_PLATFORM_NODE_PACKAGE,
  CLIENT_PACKAGE,
  PROTOCOL_PACKAGE,
  EFFECT_PACKAGE,
] as const;

let workDir = "";

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
    "resolves a scoped dependency whose export map hides package.json",
    resolvesExportRestrictedScopedPackage,
  );
  it(
    "resolves dependencies beside a pnpm virtual-store package",
    resolvesPnpmVirtualStoreDependency,
  );
  it(
    "property: resolved dependency roots never point into legacy dist node_modules",
    resolvedRootsAvoidLegacyDistNodeModules,
  );
});

describe("installChannelPlugin", () => {
  it(
    "symlinks a declared dependency from the channel node_modules",
    symlinksWorkspaceDependency,
  );
  it(
    "loads every declared dependency from an npm consumer layout",
    symlinksNpmDependencies,
    NPM_FIXTURE_TIMEOUT_MS,
  );
  it(
    "fails instead of creating a dangling link for a missing declared dependency",
    missingDeclaredDependencyFails,
  );
});

describe("testbed profile config", () => {
  it(
    "serializes the fixed selector with the network agent name",
    serializesTestbedProfile,
  );
  it("writes credentials with owner-only permissions", writesSecureProfile);
});

describe("workspace files", () => {
  it(
    "writes nested files below the agent workspace",
    writesNestedWorkspaceFile,
  );
  it(
    "rejects paths that escape the agent workspace",
    rejectsEscapingWorkspaceFiles,
  );
});

function serializesTestbedProfile() {
  expect(serializeMoltZapProfileConfig(testProfile())).toBe(
    JSON.stringify(
      {
        profiles: {
          [TESTBED_PROFILE_NAME]: {
            agentId: TEST_AGENT_ID,
            apiKey: TEST_AGENT_KEY_TEXT,
            agentName: TEST_AGENT_NAME,
          },
        },
      },
      null,
      2,
    ),
  );
}

function writesSecureProfile() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configHome = path.join(workDir, ".moltzap");
      const configPath = path.join(configHome, PROFILE_CONFIG_FILE_NAME);

      yield* writeMoltZapProfileConfig(configHome, testProfile());

      const [contents, info] = yield* Effect.all([
        fileSystem.readFileString(configPath),
        fileSystem.stat(configPath),
      ]);
      expect(contents).toBe(serializeMoltZapProfileConfig(testProfile()));
      expect(info.mode & PROFILE_FILE_PERMISSION_MASK).toBe(PROFILE_FILE_MODE);
    }),
  );
}

function testProfile() {
  return {
    agentName: TEST_AGENT_NAME,
    agentId: TEST_AGENT_ID,
    apiKey: TEST_AGENT_KEY,
  };
}

function writesNestedWorkspaceFile() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* seedWorkspaceFiles(workDir, [
        {
          relativePath: WORKSPACE_FILE_PATH,
          content: WORKSPACE_FILE_CONTENT,
        },
      ]);
      const written = yield* fileSystem.readFileString(
        path.join(workDir, "workspace", WORKSPACE_FILE_PATH),
      );
      expect(written).toBe(WORKSPACE_FILE_CONTENT);
    }),
  );
}

function rejectsEscapingWorkspaceFiles() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const escapedPath = path.join(workDir, "escaped.md");
      for (const relativePath of ["../escaped.md", escapedPath]) {
        yield* seedWorkspaceFiles(workDir, [
          { relativePath, content: "escape" },
        ]).pipe(Effect.flip);
      }
      expect(yield* fileSystem.exists(escapedPath)).toBe(false);
    }),
  );
}

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

      yield* expectSamePath(resolved, depPkg);
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

      yield* expectSamePath(resolved, hoistedDep);
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

      yield* expectSamePath(resolved, depPkg);
    }),
  );
}

function resolvesExportRestrictedScopedPackage() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const channelPkg = path.join(
        workDir,
        "node_modules",
        OPENCLAW_CHANNEL_PACKAGE,
      );
      const clientPkg = path.join(workDir, "node_modules", CLIENT_PACKAGE);
      yield* seedPackage(channelPkg, { name: OPENCLAW_CHANNEL_PACKAGE });
      yield* seedExportRestrictedPackage(clientPkg, CLIENT_PACKAGE);

      const resolved = yield* resolveChannelDependency(
        channelPkg,
        CLIENT_PACKAGE,
      );

      yield* expectSamePath(resolved, clientPkg);
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

function resolvesPnpmVirtualStoreDependency() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const consumerNodeModules = path.join(workDir, "pnpm", "node_modules");
      const virtualNodeModules = path.join(
        consumerNodeModules,
        ".pnpm",
        "@moltzap+openclaw-channel@1.0.0",
        "node_modules",
      );
      const realChannelPackage = path.join(
        virtualNodeModules,
        OPENCLAW_CHANNEL_PACKAGE,
      );
      const linkedChannelPackage = path.join(
        consumerNodeModules,
        OPENCLAW_CHANNEL_PACKAGE,
      );
      const dependencyPackage = path.join(
        virtualNodeModules,
        FANCY_DEP_PACKAGE,
      );

      yield* seedPackage(realChannelPackage, {
        name: OPENCLAW_CHANNEL_PACKAGE,
      });
      yield* seedPackage(dependencyPackage, { name: FANCY_DEP_PACKAGE });
      yield* makeDirectory(path.dirname(linkedChannelPackage));
      yield* fileSystem.symlink(realChannelPackage, linkedChannelPackage);

      const resolved = yield* resolveChannelDependency(
        linkedChannelPackage,
        FANCY_DEP_PACKAGE,
      );

      yield* expectSamePath(resolved, dependencyPackage);
    }),
  );
}

function symlinksWorkspaceDependency() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fixture = yield* createWorkspaceDependencyFixture(workDir);

      const effectResolved = yield* resolveChannelDependency(
        fixture.channelPkg,
        EFFECT_PACKAGE,
      );
      yield* expectSamePath(effectResolved, fixture.channelDepDir);

      const extDir = yield* installPlugin(fixture);
      yield* assertEffectSymlinkTarget(extDir, fixture.channelDepDir);
    }),
  );
}

function symlinksNpmDependencies() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const fixture = yield* createNpmDependencyFixture(workDir);

      const extDir = yield* installPlugin(fixture);

      yield* Effect.forEach(
        fixture.dependencies,
        (dependency) =>
          assertPackageSymlinkTarget(
            extDir,
            dependency.packageName,
            dependency.packageDir,
          ),
        { concurrency: 1, discard: true },
      );
      yield* loadCopiedChannelEntry(extDir);
    }),
  );
}

function missingDeclaredDependencyFails() {
  return runWithNodeFileSystem(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const missingPackage = "missing-dependency";
      const channelPkg = path.join(workDir, "missing", CHANNEL_PACKAGE_DIR);
      const channelDist = path.join(channelPkg, "dist");
      const stateDir = path.join(workDir, ".missing-state");
      yield* seedChannelPackage(channelPkg, [missingPackage]);
      yield* seedChannelEntry(channelDist, []);
      yield* makeDirectory(stateDir);

      const error = yield* installChannelPlugin({
        stateDir,
        channelDistDir: channelDist,
        extName: CHANNEL_EXTENSION_NAME,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ChannelPluginInstallError",
        message: expect.stringContaining(missingPackage),
      });
      const missingLink = path.join(
        stateDir,
        "extensions",
        CHANNEL_EXTENSION_NAME,
        "node_modules",
        missingPackage,
      );
      const linkTarget = yield* fileSystem
        .readLink(missingLink)
        .pipe(Effect.option);
      expect(Option.isNone(linkTarget)).toBe(true);
    }),
  );
}

function createWorkspaceDependencyFixture(root: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const channelPkg = path.join(root, "packages", CHANNEL_PACKAGE_DIR);
    const channelDist = path.join(channelPkg, "dist");
    const channelDepDir = path.join(channelPkg, "node_modules", EFFECT_PACKAGE);
    const stateDir = path.join(root, ".state");

    yield* seedChannelPackage(channelPkg, [EFFECT_PACKAGE]);
    yield* seedChannelEntry(channelDist, []);
    yield* seedLoadableExportRestrictedPackage(channelDepDir, EFFECT_PACKAGE);
    yield* makeDirectory(stateDir);

    return { channelPkg, channelDist, channelDepDir, stateDir };
  });
}

function createNpmDependencyFixture(root: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const consumerRoot = path.join(root, "consumer");
    const channelPkg = path.join(
      consumerRoot,
      "node_modules",
      OPENCLAW_CHANNEL_PACKAGE,
    );
    const channelDist = path.join(channelPkg, "dist");
    const stateDir = path.join(root, ".npm-state");
    const dependencies = CHANNEL_DEPENDENCIES.map((packageName) => ({
      packageName,
      packageDir: path.join(consumerRoot, "node_modules", packageName),
    }));

    yield* seedChannelPackage(channelPkg, CHANNEL_DEPENDENCIES);
    yield* seedChannelEntry(channelDist, CHANNEL_DEPENDENCIES);
    yield* Effect.forEach(
      dependencies,
      (dependency) =>
        seedLoadableExportRestrictedPackage(
          dependency.packageDir,
          dependency.packageName,
        ),
      { concurrency: 1, discard: true },
    );
    yield* makeDirectory(stateDir);

    return {
      channelDist,
      dependencies,
      stateDir,
    };
  });
}

function installPlugin(fixture: {
  readonly stateDir: string;
  readonly channelDist: string;
}) {
  return installChannelPlugin({
    stateDir: fixture.stateDir,
    channelDistDir: fixture.channelDist,
    extName: CHANNEL_EXTENSION_NAME,
  });
}

function assertEffectSymlinkTarget(extDir: string, expectedTarget: string) {
  return assertPackageSymlinkTarget(extDir, EFFECT_PACKAGE, expectedTarget);
}

function assertPackageSymlinkTarget(
  extDir: string,
  packageName: string,
  expectedTarget: string,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const symlinkPath = path.join(extDir, "node_modules", packageName);
    const linkTarget = yield* readLink(symlinkPath);
    yield* expectSamePath(linkTarget, expectedTarget);
  });
}

function expectSamePath(actual: string | null, expected: string) {
  return Effect.gen(function* () {
    expect(actual).not.toBeNull();
    const [actualReal, expectedReal] = yield* Effect.all([
      realPath(actual ?? expected),
      realPath(expected),
    ]);
    expect(actualReal).toBe(expectedReal);
  });
}

function loadCopiedChannelEntry(extDir: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const entryUrl = pathToFileURL(
      path.join(extDir, "dist", CHANNEL_ENTRY_FILE),
    ).href;
    yield* Effect.tryPromise({
      try: () => import(entryUrl),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(Effect.asVoid);
  });
}

function seedChannelPackage(
  channelPkg: string,
  dependencies: ReadonlyArray<string>,
) {
  return seedPackage(channelPkg, {
    name: OPENCLAW_CHANNEL_PACKAGE,
    type: "module",
    dependencies: Object.fromEntries(
      dependencies.map((packageName) => [packageName, "1.0.0"]),
    ),
  });
}

function seedChannelEntry(
  channelDist: string,
  dependencies: ReadonlyArray<string>,
) {
  const source = [
    ...dependencies.map(
      (packageName) => `import ${JSON.stringify(packageName)};`,
    ),
    "export const loaded = true;",
    "",
  ].join("\n");
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* makeDirectory(channelDist);
    yield* writeTextFile(path.join(channelDist, CHANNEL_ENTRY_FILE), source);
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

function seedExportRestrictedPackage(pkgDir: string, packageName: string) {
  return seedPackage(pkgDir, {
    name: packageName,
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
  });
}

function seedLoadableExportRestrictedPackage(
  pkgDir: string,
  packageName: string,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* seedPackage(pkgDir, {
      name: packageName,
      type: "module",
      exports: { ".": "./index.js" },
    });
    yield* writeTextFile(
      path.join(pkgDir, "index.js"),
      "export const loaded = true;\n",
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

function realPath(filePath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(filePath)),
  );
}

function runWithNodeFileSystem<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));
}
