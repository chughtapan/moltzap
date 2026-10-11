#!/usr/bin/env node
/**
 * Exercises the graph gate against the same resolved export supplied by CI.
 * Graph mutations stay in memory and manifest mutations stay in owned scratch
 * files. Read-only source links let the gate inspect the current product set;
 * the working tree is never planted or restored.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{data: {root: string, targets: Record<string, unknown>}}} Project
 * @typedef {{source: string, target: string, type: string}} Dependency
 * @typedef {{graph: {nodes: Record<string, Project>, dependencies: Record<string, Dependency[]>}}} Graph
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = resolve(root, "scripts/architecture/check-boundaries.js");
const native = "@moltzap/native-plugins";

/** @type {Graph} */
const baseline = JSON.parse(readFileSync(0, "utf8"));

/**
 * Graph input travels through stdin rather than a persistent fixture file.
 * @param {Graph} graph Resolved Nx graph or one bounded mutation of it.
 * @param {string} [cwd] Real workspace or isolated manifest fixture root.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Gate result.
 */
function runGate(graph, cwd = root) {
  return spawnSync(process.execPath, [checker, "--nx-graph", "/dev/stdin"], {
    cwd,
    input: JSON.stringify(graph),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

const clean = runGate(baseline);
assert.equal(clean.status, 0, clean.stderr);
assert.match(
  clean.stdout,
  /exact five-product static graph, 4 published manifests/,
);
assert.equal(baseline.graph.nodes[native].data.root, "plugins");

/** @type {Array<{name: string, mutate: (graph: Graph) => void, failure: RegExp}>} */
const cases = [
  {
    name: "missing asset node",
    mutate: ({ graph }) => {
      delete graph.nodes[native];
    },
    failure: /missing Nx project "@moltzap\/native-plugins"/,
  },
  {
    name: "moved asset root",
    mutate: ({ graph }) => {
      graph.nodes[native].data.root = "packages/native-plugins";
    },
    failure: /expected "plugins"/,
  },
  {
    name: "missing archive target",
    mutate: ({ graph }) => {
      delete graph.nodes[native].data.targets.package;
    },
    failure: /missing required targets: package/,
  },
  {
    name: "missing asset dependency record",
    mutate: ({ graph }) => {
      delete graph.dependencies[native];
    },
    failure: /dependency entry for "@moltzap\/native-plugins" is missing/,
  },
  {
    name: "forbidden asset edge",
    mutate: ({ graph }) => {
      graph.dependencies[native].push({
        source: native,
        target: "@moltzap/identity",
        type: "static",
      });
    },
    failure: /dependencies for "@moltzap\/native-plugins" violate/,
  },
  {
    name: "product depends on assets",
    mutate: ({ graph }) => {
      graph.dependencies["@moltzap/client"].push({
        source: "@moltzap/client",
        target: native,
        type: "static",
      });
    },
    failure: /dependencies for "@moltzap\/client" violate/,
  },
  {
    name: "extra product node",
    mutate: ({ graph }) => {
      graph.nodes["@moltzap/extra-product"] = structuredClone(
        graph.nodes[native],
      );
    },
    failure: /Nx project nodes drifted/,
  },
];

for (const test of cases) {
  const candidate = structuredClone(baseline);
  test.mutate(candidate);
  const result = runGate(candidate);
  assert.equal(
    result.status,
    1,
    `${test.name}: ${result.error ?? result.stderr}`,
  );
  assert.match(result.stderr, test.failure, test.name);
}

/**
 * Private asset declarations must fail in the static gate as well as packing.
 * Only this fixture's manifest is written; linked product inputs stay read-only.
 * @returns {number} Number of refused source-manifest fixtures.
 */
function verifyManifestRefusals() {
  const fixture = mkdtempSync(join(tmpdir(), "moltzap-graph-manifest-"));
  try {
    for (const entry of [
      "packages",
      "tools",
      ".github",
      "package.json",
      "tsconfig.json",
      "knip.json",
      "LICENSE",
      "NOTICE",
    ]) {
      symlinkSync(join(root, entry), join(fixture, entry));
    }
    mkdirSync(join(fixture, "plugins"));
    const path = join(fixture, "plugins/package.json");
    const manifest = JSON.parse(
      readFileSync(join(root, "plugins/package.json"), "utf8"),
    );
    writeFileSync(path, JSON.stringify(manifest));
    const valid = runGate(baseline, fixture);
    assert.equal(valid.status, 0, valid.stderr);

    const variants = [
      { ...manifest, private: false },
      { ...manifest, name: "@moltzap/another-asset" },
      ...["version", "exports", "bin", "main", "types", "publishConfig"].map(
        (field) => ({ ...manifest, [field]: "forbidden" }),
      ),
      {
        ...manifest,
        dependencies: { ...manifest.dependencies, "@moltzap/client": "*" },
      },
      {
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          "@moltzap/identity": "workspace:*",
        },
      },
      { ...manifest, nx: { targets: {} } },
    ];
    for (const candidate of variants) {
      writeFileSync(path, JSON.stringify(candidate));
      const refused = runGate(baseline, fixture);
      assert.equal(refused.status, 1, refused.error ?? refused.stderr);
      assert.match(refused.stderr, /plugins\/package\.json:/);
    }
    return variants.length;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const refusedManifests = verifyManifestRefusals();
console.log(
  `architecture graph: actual export passed; ${cases.length} graph and ${refusedManifests} source-manifest regressions rejected`,
);
