#!/usr/bin/env node
/**
 * @file Tests for the release's package selection and content hash.
 *
 * Invoked via `pnpm test:select-packages`. The selection runs over an
 * in-memory workspace whose content hash includes each sibling pin, as a
 * packed manifest does; the hash runs over real temporary directories.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contentHashOfDirectory } from "./content-hash.ts";
import {
  type Manifest,
  type Recorded,
  selectPackages,
  type Workspace,
} from "./select-packages.ts";

const RELEASE = "2099.101.0";
const PREVIOUS = "2099.100.0";

/** The four published packages, in the order publish.yml lists them. */
const DIRS = ["identity", "router", "client", "openclaw-channel"] as const;

const DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  identity: [],
  router: ["identity"],
  client: ["identity", "router"],
  "openclaw-channel": ["client"],
};

const MANIFEST = {
  name: "@moltzap/openclaw-channel",
  version: PREVIOUS,
  dependencies: { "@moltzap/client": PREVIOUS },
};
const FILES = { "dist/index.js": "export {};\n", "openclaw.plugin.json": "{}" };

/** Npm holds every PREVIOUS version with the hash it was published with. */
const AS_PUBLISHED = (): Recorded | undefined => undefined;

// @agent-code-guard/regression-only: Each case is one release scenario the publish workflow must get right: client-only, identity, unchanged, missing hash, npm outage, and misordered packages.

await test("a client-only change publishes the client and the channel that pins it", () => {
  const { workspace, versions } = fakeWorkspace(
    { client: "client-changed" },
    AS_PUBLISHED,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: ["client", "openclaw-channel"],
  });
  assert.deepEqual(Object.fromEntries(versions), {
    identity: PREVIOUS,
    router: PREVIOUS,
    client: RELEASE,
    "openclaw-channel": RELEASE,
  });
});

await test("an identity change publishes every package, since each pins identity", () => {
  const { workspace } = fakeWorkspace(
    { identity: "identity-changed" },
    AS_PUBLISHED,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: [...DIRS],
  });
});

await test("an unchanged workspace publishes nothing", () => {
  const { workspace } = fakeWorkspace({}, AS_PUBLISHED);
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: [],
  });
});

await test("a version npm holds without a recorded hash is republished", () => {
  const { workspace } = fakeWorkspace({}, (name) =>
    name === "@moltzap/router" ? { kind: "absent" } : undefined,
  );
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), {
    kind: "selected",
    dirs: ["router", "client", "openclaw-channel"],
  });
});

await test("an npm outage stops the selection", () => {
  const outage: Recorded = { kind: "unavailable", message: "E503" };
  const { workspace } = fakeWorkspace({}, () => outage);
  assert.deepEqual(selectPackages(workspace, RELEASE, DIRS), outage);
});

await test("a package listed before a sibling it depends on stops the selection", () => {
  const { workspace, versions } = fakeWorkspace({}, AS_PUBLISHED);
  assert.deepEqual(
    selectPackages(workspace, RELEASE, [
      "router",
      "identity",
      "client",
      "openclaw-channel",
    ]),
    {
      kind: "out-of-order",
      message: "router depends on @moltzap/identity, which must come before it",
    },
  );
  assert.equal(versions.get("router"), PREVIOUS);
});

await test("the content hash ignores the version, the recorded hash, and key order", () => {
  assert.equal(
    hashOf(
      {
        sharnessContentHash: "sha256:old",
        dependencies: MANIFEST.dependencies,
        version: RELEASE,
        name: MANIFEST.name,
      },
      FILES,
    ),
    hashOf(MANIFEST, FILES),
  );
});

await test("the content hash changes with any packed file or sibling pin", () => {
  const base = hashOf(MANIFEST, FILES);
  assert.notEqual(
    hashOf(MANIFEST, { ...FILES, "dist/index.js": "export const a = 1;\n" }),
    base,
  );
  assert.notEqual(hashOf(MANIFEST, { ...FILES, "dist/extra.js": "" }), base);
  assert.notEqual(
    hashOf(
      { ...MANIFEST, dependencies: { "@moltzap/client": RELEASE } },
      FILES,
    ),
    base,
  );
});

/** An in-memory workspace and the manifest version of each package. */
interface Fake {
  readonly workspace: Workspace;
  readonly versions: Map<string, string>;
}

/**
 * Every package was last published at PREVIOUS with the hash its source and
 * pins had then; `code` overrides a package's current source, and `recorded`
 * overrides what npm answers for a version.
 */
function fakeWorkspace(
  code: Readonly<Record<string, string>>,
  recorded: (name: string, version: string) => Recorded | undefined,
): Fake {
  const versions = new Map<string, string>(DIRS.map((dir) => [dir, PREVIOUS]));
  const published = new Map(
    DIRS.map((dir) => [
      `@moltzap/${dir}@${PREVIOUS}`,
      packedHash(dir, `${dir}-source`, () => PREVIOUS),
    ]),
  );
  const workspace: Workspace = {
    manifest: (dir): Manifest => ({
      name: `@moltzap/${dir}`,
      version: versions.get(dir) ?? PREVIOUS,
      dependencies: Object.fromEntries(
        (DEPENDENCIES[dir] ?? []).map((sibling) => [
          `@moltzap/${sibling}`,
          "workspace:*",
        ]),
      ),
    }),
    contentHash: (dir) =>
      packedHash(
        dir,
        code[dir] ?? `${dir}-source`,
        (sibling) => versions.get(sibling) ?? PREVIOUS,
      ),
    recordedHash: (name, version) => {
      const hash = published.get(`${name}@${version}`);
      return (
        recorded(name, version) ??
        (hash === undefined ? { kind: "absent" } : { kind: "hash", hash })
      );
    },
    select: (dir, version) => {
      versions.set(dir, version);
    },
  };
  return { workspace, versions };
}

/** A fake content hash: the package's source and each sibling pin. */
function packedHash(
  dir: string,
  source: string,
  pin: (sibling: string) => string,
): string {
  const pins = (DEPENDENCIES[dir] ?? []).map(
    (sibling) => sibling + "@" + pin(sibling),
  );
  return `${source}|${pins.join(",")}`;
}

function hashOf(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): string {
  const root = packedDirectory(manifest, files);
  const hash = contentHashOfDirectory(root);
  rmSync(root, { recursive: true, force: true });
  return hash;
}

function packedDirectory(
  manifest: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, string>>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "content-hash-test-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return root;
}
