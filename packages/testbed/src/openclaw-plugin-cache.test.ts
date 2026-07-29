import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  materializeOpenClawPluginCacheGeneration,
  openClawPluginCacheFingerprint,
  validateOpenClawPluginProject,
} from "./openclaw-plugin-cache.js";

const CHANNEL_PACKAGE_NAME = "@moltzap/openclaw-channel";
const CHANNEL_VERSION = "1.2.3";
const OPENCLAW_VERSION = "2026.6.33";
const TEST_PLATFORM = "test-platform";
const TEST_ARCHITECTURE = "test-architecture";
const OTHER_CHANNEL_VERSION = "1.2.4";
const OTHER_OPENCLAW_VERSION = "2026.6.34";
const OTHER_PLATFORM = "other-platform";
const OTHER_ARCHITECTURE = "other-architecture";
const PROJECT_SLUG = "moltzap-openclaw-channel-test";
const CHANNEL_PAYLOAD = "registry plugin payload";
const HASH_HEX_LENGTH = 64;
const REGISTRY_CHANNEL_TARBALL =
  "https://registry.npmjs.org/@moltzap/openclaw-channel/-/openclaw-channel-1.2.3.tgz";
const LOCAL_CHANNEL_TARBALL = "file:../openclaw-channel.tgz";
const TEST_INTEGRITY = "sha512-test-integrity";

const BASE_FINGERPRINT_INPUT = {
  channelVersion: CHANNEL_VERSION,
  openclawVersion: OPENCLAW_VERSION,
  platform: TEST_PLATFORM,
  architecture: TEST_ARCHITECTURE,
} as const;

const FINGERPRINT_VARIANTS = [
  {
    label: "channel version",
    input: {
      ...BASE_FINGERPRINT_INPUT,
      channelVersion: OTHER_CHANNEL_VERSION,
    },
  },
  {
    label: "OpenClaw version",
    input: {
      ...BASE_FINGERPRINT_INPUT,
      openclawVersion: OTHER_OPENCLAW_VERSION,
    },
  },
  {
    label: "platform",
    input: { ...BASE_FINGERPRINT_INPUT, platform: OTHER_PLATFORM },
  },
  {
    label: "architecture",
    input: {
      ...BASE_FINGERPRINT_INPUT,
      architecture: OTHER_ARCHITECTURE,
    },
  },
] as const;

describe("OpenClaw published plugin cache fingerprint", () => {
  const baseline = openClawPluginCacheFingerprint(BASE_FINGERPRINT_INPUT);

  it("is a sha256 digest", () => {
    expect(baseline).toHaveLength(HASH_HEX_LENGTH);
  });

  it.each(FINGERPRINT_VARIANTS)("includes $label", ({ input }) => {
    expect(openClawPluginCacheFingerprint(input)).not.toBe(baseline);
  });
});

describe("OpenClaw npm project provenance", () => {
  it(
    "accepts exact registry-backed MoltZap artifacts",
    acceptsRegistryArtifacts,
  );
  it("rejects a local MoltZap artifact", rejectsLocalArtifacts);
});

describe("OpenClaw plugin cache materialization", () => {
  it(
    "copies one project and rebuilds its OpenClaw peer link",
    rebuildsOpenClawPeerLink,
  );
  it(
    "fails clearly when the canonical OpenClaw package is absent",
    rejectsMissingOpenClawPackage,
  );
});

function acceptsRegistryArtifacts() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const projectDir = join(root, "valid-project");
      yield* seedProject(projectDir, REGISTRY_CHANNEL_TARBALL);

      const result = yield* validateOpenClawPluginProject(
        projectDir,
        CHANNEL_VERSION,
      );

      expect(result).toBeUndefined();
    }),
  );
}

function rejectsLocalArtifacts() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const projectDir = join(root, "local-project");
      yield* seedProject(projectDir, LOCAL_CHANNEL_TARBALL);

      const error = yield* validateOpenClawPluginProject(
        projectDir,
        CHANNEL_VERSION,
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OpenClawPluginCacheError",
        reason: expect.stringContaining("registry-backed"),
      });
    }),
  );
}

function rebuildsOpenClawPeerLink() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* seedCachedProject(root);

      const projectDir = yield* materializeOpenClawPluginCacheGeneration({
        generationDir: fixture.generationDir,
        stateDir: fixture.stateDir,
        openclawPackageRoot: fixture.openclawPackageRoot,
      });

      expect(
        yield* fileSystem.readFileString(
          join(projectDir, "payload.txt"),
          "utf8",
        ),
      ).toBe(CHANNEL_PAYLOAD);
      const [linkTarget, canonicalRoot] = yield* Effect.all([
        fileSystem.readLink(openclawPeerLinkPath(projectDir)),
        fileSystem.realPath(fixture.openclawPackageRoot),
      ]);
      expect(linkTarget).toBe(canonicalRoot);
    }),
  );
}

function rejectsMissingOpenClawPackage() {
  return runWithFixture((root) =>
    Effect.gen(function* () {
      const fixture = yield* seedCachedProject(root);
      const missingPackageRoot = join(root, "missing-openclaw");

      const error = yield* materializeOpenClawPluginCacheGeneration({
        generationDir: fixture.generationDir,
        stateDir: fixture.stateDir,
        openclawPackageRoot: missingPackageRoot,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OpenClawPluginCacheError",
        reason: expect.stringContaining(missingPackageRoot),
      });
    }),
  );
}

function seedProject(projectDir: string, resolved: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(projectDir, { recursive: true });
    yield* fileSystem.writeFileString(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: { [CHANNEL_PACKAGE_NAME]: CHANNEL_VERSION },
      }),
    );
    yield* fileSystem.writeFileString(
      join(projectDir, "package-lock.json"),
      JSON.stringify({
        packages: {
          "": {
            dependencies: { [CHANNEL_PACKAGE_NAME]: CHANNEL_VERSION },
          },
          [`node_modules/${CHANNEL_PACKAGE_NAME}`]: {
            version: CHANNEL_VERSION,
            resolved,
            integrity: TEST_INTEGRITY,
          },
        },
      }),
    );
  });
}

function seedCachedProject(root: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const generationDir = join(root, "generation");
    const projectDir = join(generationDir, "npm", "projects", PROJECT_SLUG);
    const stateDir = join(root, "state");
    const openclawPackageRoot = join(root, "canonical-openclaw");
    const staleOpenclawRoot = join(root, "stale-openclaw");
    const peerLink = openclawPeerLinkPath(projectDir);
    yield* Effect.all(
      [projectDir, stateDir, openclawPackageRoot, staleOpenclawRoot].map(
        (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
      ),
      { concurrency: 4, discard: true },
    );
    yield* fileSystem.writeFileString(
      join(projectDir, "payload.txt"),
      CHANNEL_PAYLOAD,
    );
    yield* fileSystem.makeDirectory(join(peerLink, ".."), {
      recursive: true,
    });
    yield* fileSystem.symlink(staleOpenclawRoot, peerLink);
    return { generationDir, openclawPackageRoot, stateDir };
  });
}

function openclawPeerLinkPath(projectDir: string): string {
  return join(
    projectDir,
    "node_modules",
    "@moltzap",
    "openclaw-channel",
    "node_modules",
    "openclaw",
  );
}

function runWithFixture<A, E>(
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem>,
) {
  return Effect.runPromise(
    Effect.scoped(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.makeTempDirectoryScoped({
            prefix: "openclaw-plugin-cache-test-",
          }),
        ),
        Effect.flatMap(use),
        Effect.provide(NodeContext.layer),
      ),
    ),
  );
}
