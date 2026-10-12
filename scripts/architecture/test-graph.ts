#!/usr/bin/env node
/**
 * @file Exercises the graph gate against the same resolved export supplied by CI.
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

interface Project {
  data: { root: string; targets: Record<string, unknown> };
}
interface Dependency {
  readonly source: string;
  readonly target: string;
  readonly type: string;
}
interface Graph {
  readonly graph: {
    readonly nodes: Record<string, Project>;
    readonly dependencies: Record<string, Dependency[]>;
  };
}
interface GraphCase {
  readonly name: string;
  readonly mutate: (graph: Graph) => void;
  readonly failure: RegExp;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = resolve(root, "scripts/architecture/check-boundaries.ts");
const native = "@moltzap/native-plugins";

const baseline = decodeGraph(readFileSync(0, "utf8"));

/**
 * Graph input travels through stdin rather than a persistent fixture file.
 * @param graph Resolved Nx graph or one bounded mutation of it.
 * @param cwd Real workspace or isolated manifest fixture root.
 * @returns Gate result.
 */
const clean = runGate(baseline);
assert.equal(clean.status, 0, clean.stderr);
assert.match(
  clean.stdout,
  /exact five-product static graph, 4 published manifests/,
);
assert.equal(project(baseline, native).data.root, "plugins");

const cases: readonly GraphCase[] = [
  {
    name: "missing asset node",
    mutate: ({ graph }) => {
      delete graph.nodes["@moltzap/native-plugins"];
    },
    failure: /missing Nx project "@moltzap\/native-plugins"/,
  },
  {
    name: "moved asset root",
    mutate: (graph) => {
      project(graph, native).data.root = "packages/native-plugins";
    },
    failure: /expected "plugins"/,
  },
  {
    name: "missing archive target",
    mutate: (graph) => {
      delete project(graph, native).data.targets.package;
    },
    failure: /missing required targets: package/,
  },
  {
    name: "missing asset dependency record",
    mutate: ({ graph }) => {
      delete graph.dependencies["@moltzap/native-plugins"];
    },
    failure: /dependency entry for "@moltzap\/native-plugins" is missing/,
  },
  {
    name: "forbidden asset edge",
    mutate: (graph) => {
      dependencies(graph, native).push({
        source: native,
        target: "@moltzap/identity",
        type: "static",
      });
    },
    failure: /dependencies for "@moltzap\/native-plugins" violate/,
  },
  {
    name: "product depends on assets",
    mutate: (graph) => {
      dependencies(graph, "@moltzap/client").push({
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
        project({ graph }, native),
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
 */
function verifyManifestRefusals(): number {
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
    const manifest = decodeObject(
      readFileSync(join(root, "plugins/package.json"), "utf8"),
    );
    writeFileSync(path, JSON.stringify(manifest));
    const valid = runGate(baseline, fixture);
    assert.equal(valid.status, 0, valid.stderr);

    const variants = manifestVariants(manifest);
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

function manifestVariants(manifest: Readonly<Record<string, unknown>>) {
  return [
    { ...manifest, private: false },
    { ...manifest, name: "@moltzap/another-asset" },
    ...["version", "exports", "bin", "main", "types", "publishConfig"].map(
      (field) => ({ ...manifest, [field]: "forbidden" }),
    ),
    {
      ...manifest,
      dependencies: {
        ...object(manifest.dependencies),
        "@moltzap/client": "*",
      },
    },
    {
      ...manifest,
      dependencies: {
        ...object(manifest.dependencies),
        "@moltzap/identity": "workspace:*",
      },
    },
    { ...manifest, nx: { targets: {} } },
  ];
}

/** Graph input travels through stdin, never a persistent fixture file. */
function runGate(graph: Graph, cwd = root) {
  return spawnSync(process.execPath, [checker, "--nx-graph", "/dev/stdin"], {
    cwd,
    input: JSON.stringify(graph),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

const refusedManifests = verifyManifestRefusals();
console.log(
  `architecture graph: actual export passed; ${cases.length} graph and ${refusedManifests} source-manifest regressions rejected`,
);

/** The graph comes from the real Nx export; narrowing never silently drops a node or edge. */
function decodeGraph(text: string): Graph {
  const wrapper = decodeObject(text);
  const graph = object(wrapper.graph);
  const nodes = Object.fromEntries(
    Object.entries(object(graph.nodes)).map(([name, value]) => {
      const node = object(value);
      const data = object(node.data);
      assert.equal(typeof data.root, "string");
      return [
        name,
        {
          ...node,
          data: {
            ...data,
            root: String(data.root),
            targets: object(data.targets),
          },
        },
      ];
    }),
  );
  const edges = Object.fromEntries(
    Object.entries(object(graph.dependencies)).map(([name, value]) => {
      assert.ok(Array.isArray(value));
      return [
        name,
        value.map((entry: unknown) => {
          const edge = object(entry);
          assert.ok(
            typeof edge.source === "string" &&
              typeof edge.target === "string" &&
              typeof edge.type === "string",
          );
          return { source: edge.source, target: edge.target, type: edge.type };
        }),
      ];
    }),
  );
  return { graph: { nodes, dependencies: edges } };
}

function decodeObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return object(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function project(graph: Graph, name: string): Project {
  const node = graph.graph.nodes[name];
  assert.ok(node !== undefined, `fixture graph has no ${name} node`);
  return node;
}

function dependencies(graph: Graph, name: string): Dependency[] {
  const edges = graph.graph.dependencies[name];
  assert.ok(
    edges !== undefined,
    `fixture graph has no ${name} dependency record`,
  );
  return edges;
}
