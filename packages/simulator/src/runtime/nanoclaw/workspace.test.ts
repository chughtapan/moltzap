import { createHash } from "node:crypto";
import { join } from "node:path";
import { Command, FileSystem } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeCommandHelpers } from "../command.js";
import {
  assertNanoclawWorkspaceLock,
  assertPackedWorkspaceVersions,
  materializeNanoclawWorkspaceDependencies,
  nanoclawCacheFingerprint,
  rewriteNanoclawWorkspaceManifest,
  type NanoclawWorkspaceDependencies,
  type NanoclawWorkspaceTarball,
} from "./install.js";

const NANOCLAW_SHA = "641963c1e4b7ba4f000a18dfc5e2fea29069feec";
const NANOCLAW_CACHE_SCHEMA_VERSION = 5;
const CLIENT_PACKAGE_NAME = "@moltzap/client";
const PROTOCOL_PACKAGE_NAME = "@moltzap/protocol";
const PACKAGE_VERSION = "2026.724.2";
const STALE_PACKAGE_VERSION = "2026.724.1";
const CLIENT_TARBALL_FILE = "moltzap-client-2026.724.2.tgz";
const PROTOCOL_TARBALL_FILE = "moltzap-protocol-2026.724.2.tgz";
const CLIENT_TARBALL_SPEC = `file:vendor/${CLIENT_TARBALL_FILE}`;
const PROTOCOL_TARBALL_SPEC = `file:vendor/${PROTOCOL_TARBALL_FILE}`;
const CLIENT_INTEGRITY = "sha512-client-integrity";
const PROTOCOL_INTEGRITY = "sha512-protocol-integrity";
const STALE_INTEGRITY = "sha512-stale-integrity";
const OTHER_DEPENDENCY_NAME = "effect";
const OTHER_DEPENDENCY_VERSION = "3.22.0";
const BUILD_SCRIPT = "tsc";
const PROTOCOL_MISMATCH_REASON = "packed client protocol dependency";
const HASH_HEX_LENGTH = 64;
const CLIENT_HASH = "a".repeat(HASH_HEX_LENGTH);
const OTHER_CLIENT_HASH = "b".repeat(HASH_HEX_LENGTH);
const PROTOCOL_HASH = "c".repeat(HASH_HEX_LENGTH);
const OTHER_PROTOCOL_HASH = "d".repeat(HASH_HEX_LENGTH);
const REGISTRY_LEAK = "https://registry.npmjs.org/@moltzap/client/-/client.tgz";
const FIXTURE_PACKAGE_NAME = "nanoclaw-workspace-staging-fixture";
const FIXTURE_PACKAGE_VERSION = "1.0.0";
const FIXTURE_COMMAND_TIMEOUT_MS = 30_000;
const FIXTURE_TEST_TIMEOUT_MS = 150_000;
const FIXTURE_NPM_CONFIG = [
  "offline=true",
  "audit=false",
  "fund=false",
  "update-notifier=false",
].join("\n");

const { commandOutputEffect } = makeCommandHelpers(
  (reason, cause) =>
    new Error(reason, cause === undefined ? undefined : { cause }),
);

const WORKSPACE_DEPENDENCIES = {
  client: {
    packageName: CLIENT_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    tarballPath: `/fixtures/${CLIENT_TARBALL_FILE}`,
    tarballFileName: CLIENT_TARBALL_FILE,
    sha256: CLIENT_HASH,
    integrity: CLIENT_INTEGRITY,
  },
  protocol: {
    packageName: PROTOCOL_PACKAGE_NAME,
    version: PACKAGE_VERSION,
    tarballPath: `/fixtures/${PROTOCOL_TARBALL_FILE}`,
    tarballFileName: PROTOCOL_TARBALL_FILE,
    sha256: PROTOCOL_HASH,
    integrity: PROTOCOL_INTEGRITY,
  },
} as const satisfies NanoclawWorkspaceDependencies;

const FINGERPRINT_INPUT = {
  channelHash: "channel-hash",
  evalProvisionHash: "eval-provision-hash",
  skillHash: "skill-hash",
  packageJsonHash: "package-json-hash",
  packageLockHash: "package-lock-hash",
  platform: "test-platform",
  architecture: "test-architecture",
  nodeAbi: "test-node-abi",
} as const;

// @agent-code-guard/regression-only: these cases pin cache compatibility and workspace rebuild invalidation
describe("NanoClaw workspace cache fingerprint", () => {
  it("preserves the published fingerprint payload", preservesPublishedHash);
  it(
    "keys both workspace tarballs and remains stable",
    includesWorkspaceHashes,
  );
});

// @agent-code-guard/regression-only: fixture manifests and locks pin every local-artifact provenance check
describe("NanoClaw workspace dependency staging", () => {
  it(
    "copies tarballs and refreshes an offline npm lock",
    materializesWorkspaceDependencies,
    FIXTURE_TEST_TIMEOUT_MS,
  );
  it(
    "rewrites both direct dependencies and preserves other fields",
    rewritesManifest,
  );
  it("accepts an exact two-package file lock", acceptsWorkspaceLock);
  it(
    "rejects a packed client built against another protocol",
    rejectsMismatchedBuilds,
  );
  it("rejects MoltZap registry leakage", rejectsRegistryLeakage);
  it("rejects a nested protocol copy", rejectsNestedProtocol);
  it("rejects stale tarball integrity", rejectsStaleIntegrity);
});

function preservesPublishedHash() {
  const expected = createHash("sha256")
    .update(
      JSON.stringify({
        cacheSchema: NANOCLAW_CACHE_SCHEMA_VERSION,
        nanoclawSha: NANOCLAW_SHA,
        ...FINGERPRINT_INPUT,
      }),
    )
    .digest("hex");

  expect(nanoclawCacheFingerprint(FINGERPRINT_INPUT)).toBe(expected);
}

function includesWorkspaceHashes() {
  const baseline = nanoclawCacheFingerprint(FINGERPRINT_INPUT, {
    clientTarballHash: CLIENT_HASH,
    protocolTarballHash: PROTOCOL_HASH,
  });
  const clientRebuilt = nanoclawCacheFingerprint(FINGERPRINT_INPUT, {
    clientTarballHash: OTHER_CLIENT_HASH,
    protocolTarballHash: PROTOCOL_HASH,
  });
  const protocolRebuilt = nanoclawCacheFingerprint(FINGERPRINT_INPUT, {
    clientTarballHash: CLIENT_HASH,
    protocolTarballHash: OTHER_PROTOCOL_HASH,
  });
  const repeated = nanoclawCacheFingerprint(FINGERPRINT_INPUT, {
    clientTarballHash: CLIENT_HASH,
    protocolTarballHash: PROTOCOL_HASH,
  });

  expect(clientRebuilt).not.toBe(baseline);
  expect(protocolRebuilt).not.toBe(baseline);
  expect(repeated).toBe(baseline);
}

function materializesWorkspaceDependencies() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const prepared = yield* prepareWorkspaceStagingFixture(root);
      yield* materializeNanoclawWorkspaceDependencies(
        prepared.stagingDir,
        prepared.dependencies,
      );
      yield* assertMaterializedWorkspaceFixture(prepared);
    }),
  );
}

function prepareWorkspaceStagingFixture(root: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const packDir = join(root, "packs");
    const stagingDir = join(root, "staging");
    yield* fileSystem.makeDirectory(packDir, { recursive: true });
    const protocol = yield* packFixturePackage({
      root,
      packDir,
      directoryName: "protocol",
      packageName: PROTOCOL_PACKAGE_NAME,
      tarballFileName: PROTOCOL_TARBALL_FILE,
      dependencies: {},
    });
    const client = yield* packFixturePackage({
      root,
      packDir,
      directoryName: "client",
      packageName: CLIENT_PACKAGE_NAME,
      tarballFileName: CLIENT_TARBALL_FILE,
      dependencies: { [PROTOCOL_PACKAGE_NAME]: PACKAGE_VERSION },
    });
    yield* seedWorkspaceStagingDir(root, stagingDir);
    return {
      stagingDir,
      dependencies: { client, protocol },
    } satisfies MaterializedWorkspaceFixture;
  });
}

interface FixturePackageInput {
  readonly root: string;
  readonly packDir: string;
  readonly directoryName: string;
  readonly packageName: string;
  readonly tarballFileName: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

function packFixturePackage(input: FixturePackageInput) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const packageDir = join(input.root, input.directoryName);
    yield* fileSystem.makeDirectory(packageDir, { recursive: true });
    yield* fileSystem.writeFileString(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: input.packageName,
        version: PACKAGE_VERSION,
        dependencies: input.dependencies,
      }),
    );
    const command = Command.make(
      "npm",
      "pack",
      "--pack-destination",
      input.packDir,
      "--cache",
      join(input.root, "npm-cache"),
      "--offline",
    ).pipe(Command.workingDirectory(packageDir));
    yield* commandOutputEffect(`pack fixture ${input.packageName}`, command, {
      timeout: FIXTURE_COMMAND_TIMEOUT_MS,
    });
    return yield* describeFixtureTarball(
      join(input.packDir, input.tarballFileName),
      input.packageName,
      input.tarballFileName,
    );
  });
}

function describeFixtureTarball(
  tarballPath: string,
  packageName: string,
  tarballFileName: string,
) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFile(tarballPath)),
    Effect.map(
      (bytes) =>
        ({
          packageName,
          version: PACKAGE_VERSION,
          tarballPath,
          tarballFileName,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          integrity:
            "sha512-" + createHash("sha512").update(bytes).digest("base64"),
        }) satisfies NanoclawWorkspaceTarball,
    ),
  );
}

function seedWorkspaceStagingDir(root: string, stagingDir: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dependencies = {
      [CLIENT_PACKAGE_NAME]: STALE_PACKAGE_VERSION,
      [PROTOCOL_PACKAGE_NAME]: STALE_PACKAGE_VERSION,
    };
    yield* fileSystem.makeDirectory(stagingDir, { recursive: true });
    yield* fileSystem.writeFileString(
      join(stagingDir, "package.json"),
      JSON.stringify({
        name: FIXTURE_PACKAGE_NAME,
        version: FIXTURE_PACKAGE_VERSION,
        private: true,
        scripts: { build: BUILD_SCRIPT },
        dependencies,
      }),
    );
    yield* fileSystem.writeFileString(
      join(stagingDir, "package-lock.json"),
      JSON.stringify({
        name: FIXTURE_PACKAGE_NAME,
        version: FIXTURE_PACKAGE_VERSION,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: FIXTURE_PACKAGE_NAME,
            version: FIXTURE_PACKAGE_VERSION,
            dependencies,
          },
        },
      }),
    );
    yield* fileSystem.writeFileString(
      join(stagingDir, ".npmrc"),
      `${FIXTURE_NPM_CONFIG}\ncache=${join(root, "npm-cache")}\n`,
    );
  });
}

interface MaterializedWorkspaceFixture {
  readonly stagingDir: string;
  readonly dependencies: NanoclawWorkspaceDependencies;
}

function assertMaterializedWorkspaceFixture(
  fixture: MaterializedWorkspaceFixture,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (const tarball of [
      fixture.dependencies.client,
      fixture.dependencies.protocol,
    ]) {
      const [source, vendored] = yield* Effect.all([
        fileSystem.readFile(tarball.tarballPath),
        fileSystem.readFile(
          join(fixture.stagingDir, "vendor", tarball.tarballFileName),
        ),
      ]);
      expect(vendored).toEqual(source);
    }
    const manifest = readTestRecord(
      JSON.parse(
        yield* fileSystem.readFileString(
          join(fixture.stagingDir, "package.json"),
          "utf8",
        ),
      ),
    );
    const dependencies = readTestRecord(manifest.dependencies);
    expect(dependencies[CLIENT_PACKAGE_NAME]).toBe(CLIENT_TARBALL_SPEC);
    expect(dependencies[PROTOCOL_PACKAGE_NAME]).toBe(PROTOCOL_TARBALL_SPEC);
    expect(manifest.scripts).toEqual({ build: BUILD_SCRIPT });
    const lockText = yield* fileSystem.readFileString(
      join(fixture.stagingDir, "package-lock.json"),
      "utf8",
    );
    expect(lockText).not.toMatch(REGISTRY_LEAK);
    const lock = readTestRecord(JSON.parse(lockText));
    const packages = readTestRecord(lock.packages);
    expect(
      Object.keys(packages)
        .filter((key) => key.includes("node_modules/@moltzap/"))
        .sort(),
    ).toEqual([
      `node_modules/${CLIENT_PACKAGE_NAME}`,
      `node_modules/${PROTOCOL_PACKAGE_NAME}`,
    ]);
  });
}

function readTestRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isTestRecord(value)) {
    throw new Error("Expected fixture JSON object");
  }
  return value;
}

function isTestRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewritesManifest() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const manifestPath = join(root, "package.json");
      yield* fileSystem.writeFileString(
        manifestPath,
        JSON.stringify({
          name: "nanoclaw",
          scripts: { build: BUILD_SCRIPT },
          dependencies: {
            [CLIENT_PACKAGE_NAME]: PACKAGE_VERSION,
            [PROTOCOL_PACKAGE_NAME]: PACKAGE_VERSION,
            [OTHER_DEPENDENCY_NAME]: OTHER_DEPENDENCY_VERSION,
          },
        }),
      );

      yield* rewriteNanoclawWorkspaceManifest(root, WORKSPACE_DEPENDENCIES);

      const rewritten: unknown = JSON.parse(
        yield* fileSystem.readFileString(manifestPath, "utf8"),
      );
      expect(rewritten).toMatchObject({
        scripts: { build: BUILD_SCRIPT },
        dependencies: {
          [CLIENT_PACKAGE_NAME]: CLIENT_TARBALL_SPEC,
          [PROTOCOL_PACKAGE_NAME]: PROTOCOL_TARBALL_SPEC,
          [OTHER_DEPENDENCY_NAME]: OTHER_DEPENDENCY_VERSION,
        },
      });
    }),
  );
}

function acceptsWorkspaceLock() {
  return runWithLock(makeWorkspaceLock(), (root) =>
    assertNanoclawWorkspaceLock(root, WORKSPACE_DEPENDENCIES).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toBeUndefined();
        }),
      ),
    ),
  );
}

function rejectsMismatchedBuilds() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const error = yield* assertPackedWorkspaceVersions({
        clientManifest: {
          name: CLIENT_PACKAGE_NAME,
          version: PACKAGE_VERSION,
          dependencies: {
            [PROTOCOL_PACKAGE_NAME]: STALE_PACKAGE_VERSION,
          },
        },
        protocolManifest: {
          name: PROTOCOL_PACKAGE_NAME,
          version: PACKAGE_VERSION,
          dependencies: {},
        },
        clientVersion: PACKAGE_VERSION,
        protocolVersion: PACKAGE_VERSION,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "NanoclawInstallError",
        reason: expect.stringContaining(PROTOCOL_MISMATCH_REASON),
      });
    }),
  );
}

function rejectsRegistryLeakage() {
  return expectInvalidLock(
    { ...makeWorkspaceLock(), registryLeak: REGISTRY_LEAK },
    "registry artifact",
  );
}

function rejectsNestedProtocol() {
  const lock = makeWorkspaceLock();
  const packages = lock.packages;
  return expectInvalidLock(
    {
      ...lock,
      packages: {
        ...packages,
        [`node_modules/${CLIENT_PACKAGE_NAME}/node_modules/${PROTOCOL_PACKAGE_NAME}`]:
          packages[`node_modules/${PROTOCOL_PACKAGE_NAME}`],
      },
    },
    "only direct",
  );
}

function rejectsStaleIntegrity() {
  const lock = makeWorkspaceLock();
  return expectInvalidLock(
    {
      ...lock,
      packages: {
        ...lock.packages,
        [`node_modules/${CLIENT_PACKAGE_NAME}`]: {
          ...lock.packages[`node_modules/${CLIENT_PACKAGE_NAME}`],
          integrity: STALE_INTEGRITY,
        },
      },
    },
    CLIENT_INTEGRITY,
  );
}

function expectInvalidLock(
  lock: Readonly<Record<string, unknown>>,
  reasonFragment: string,
) {
  return runWithLock(lock, (root) =>
    Effect.gen(function* () {
      const error = yield* assertNanoclawWorkspaceLock(
        root,
        WORKSPACE_DEPENDENCIES,
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "NanoclawInstallError",
        reason: expect.stringContaining(reasonFragment),
      });
    }),
  );
}

function makeWorkspaceLock() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          [CLIENT_PACKAGE_NAME]: CLIENT_TARBALL_SPEC,
          [PROTOCOL_PACKAGE_NAME]: PROTOCOL_TARBALL_SPEC,
        },
      },
      [`node_modules/${CLIENT_PACKAGE_NAME}`]: {
        version: PACKAGE_VERSION,
        resolved: CLIENT_TARBALL_SPEC,
        integrity: CLIENT_INTEGRITY,
        dependencies: {
          [PROTOCOL_PACKAGE_NAME]: PACKAGE_VERSION,
        },
      },
      [`node_modules/${PROTOCOL_PACKAGE_NAME}`]: {
        version: PACKAGE_VERSION,
        resolved: PROTOCOL_TARBALL_SPEC,
        integrity: PROTOCOL_INTEGRITY,
      },
    },
  };
}

function runWithLock<A, E>(
  lock: Readonly<Record<string, unknown>>,
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) {
  return runWithFixture((root) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) =>
        fileSystem.writeFileString(
          join(root, "package-lock.json"),
          JSON.stringify(lock),
        ),
      ),
      Effect.zipRight(use(root)),
    ),
  );
}

function runWithFixture<A, E>(
  use: (
    root: string,
  ) => Effect.Effect<A, E, CommandExecutor | FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    Effect.scoped(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeTempDirectoryScoped({
            prefix: "nanoclaw-workspace-install-test-",
          }),
        ),
        Effect.flatMap(use),
        Effect.provide(NodeContext.layer),
      ),
    ),
  );
}
