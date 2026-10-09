/**
 * @file Resolved Nx graph rules of the architecture boundary check.
 *
 * CI supplies the graph Nx calculated. Keeping the Nx invocation outside the
 * check avoids starting Nx recursively when the same checks run as an Nx
 * target, while still comparing the graph Nx actually resolved.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  dependencyNames,
  FINAL_PACKAGE_DIRS,
  FINAL_PACKAGE_NAMES,
  FINAL_PACKAGES,
  type PackageDir,
} from "./boundary-contract.ts";
import {
  arrayAt,
  type BoundaryRun,
  failOnSetDrift,
  isJsonObject,
  type JsonObject,
  objectAt,
  readJsonObject,
  relativePath,
  stringAt,
} from "./boundary-run.ts";

/** The decoded graph and the label every failure about it carries. */
interface NxGraph {
  readonly label: string;
  readonly nodes: JsonObject;
  readonly dependencies: JsonObject;
}

const ADAPTER_DAEMON_DEPENDENCIES: readonly PackageDir[] = [
  "identity",
  "router",
  "client",
  "openclaw-channel",
];

/**
 * Resolve the `--nx-graph` argument, if present, and check that graph.
 * @param run Run collecting failures.
 * @param argv Process arguments after the script path.
 */
export function checkNxGraphArgument(
  run: BoundaryRun,
  argv: readonly string[],
): void {
  const flag = argv.indexOf("--nx-graph");
  if (flag === -1) {
    return;
  }
  const graphFile = argv[flag + 1];
  if (graphFile === undefined) {
    run.failures.push("--nx-graph requires a project-graph JSON path");
  } else if (existsSync(graphFile)) {
    checkNxGraph(run, path.resolve(graphFile));
  } else {
    run.failures.push(`${graphFile}: Nx project graph does not exist`);
  }
}

/**
 * Compare a resolved Nx project graph against the final-package contract.
 * @param run Run collecting failures.
 * @param graphFile Absolute path of `nx graph --print` output.
 */
function checkNxGraph(run: BoundaryRun, graphFile: string): void {
  const label = relativePath(run, graphFile);
  const graph = readJsonObject(graphFile).graph;
  if (!isJsonObject(graph) || !isJsonObject(graph.nodes)) {
    run.failures.push(`${label}: not an Nx project graph`);
    return;
  }
  const nxGraph: NxGraph = {
    label,
    nodes: graph.nodes,
    dependencies: objectAt(graph, "dependencies"),
  };
  failOnSetDrift(run, {
    where: label,
    what: "Nx project nodes drifted",
    actual: Object.keys(nxGraph.nodes),
    wanted: [...FINAL_PACKAGE_NAMES, "workspace", "adapter-daemon"],
  });
  for (const dir of FINAL_PACKAGE_DIRS) {
    checkProductNode(run, nxGraph, dir);
  }
  checkWorkspaceNode(run, nxGraph);
  checkAdapterDaemonNode(run, nxGraph);
}

function checkProductNode(
  run: BoundaryRun,
  graph: NxGraph,
  dir: PackageDir,
): void {
  const { npmName, targets } = FINAL_PACKAGES[dir];
  const node = graph.nodes[npmName];
  if (!isJsonObject(node)) {
    run.failures.push(`${graph.label}: missing Nx project "${npmName}"`);
    return;
  }
  const data = objectAt(node, "data");
  const root = stringAt(data, "root");
  if (root !== `packages/${dir}`) {
    run.failures.push(
      `${graph.label}: Nx project "${npmName}" root is "${root ?? "missing"}", expected "packages/${dir}"`,
    );
  }
  const resolvedTargets = Object.keys(objectAt(data, "targets"));
  const missingTargets = targets.filter(
    (target) => !resolvedTargets.includes(target),
  );
  if (missingTargets.length > 0) {
    run.failures.push(
      `${graph.label}: Nx project "${npmName}" is missing required targets: ${missingTargets.join(", ")}`,
    );
  }
  if (!Array.isArray(graph.dependencies[npmName])) {
    run.failures.push(
      `${graph.label}: Nx dependency entry for "${npmName}" is missing`,
    );
    return;
  }
  failOnSetDrift(run, {
    where: graph.label,
    what: `Nx dependencies for "${npmName}" violate the final DAG`,
    actual: dependencyTargets(graph, npmName),
    wanted: dependencyNames(dir),
  });
}

function checkWorkspaceNode(run: BoundaryRun, graph: NxGraph): void {
  const data = nodeData(graph, "workspace");
  const root = stringAt(data, "root");
  if (root !== "tools/workspace") {
    run.failures.push(
      `${graph.label}: Nx project "workspace" root is "${root ?? "missing"}", expected "tools/workspace"`,
    );
  }
  const targets = objectAt(data, "targets");
  for (const target of [
    "lint",
    "lint:architecture-boundaries",
    "lint:effect",
  ]) {
    if (!Object.hasOwn(targets, target)) {
      run.failures.push(
        `${graph.label}: Nx project "workspace" is missing required target "${target}"`,
      );
    }
  }
  failOnSetDrift(run, {
    where: graph.label,
    what: 'Nx dependencies for "workspace" drifted',
    actual: dependencyTargets(graph, "workspace"),
    wanted: [],
  });
}

function checkAdapterDaemonNode(run: BoundaryRun, graph: NxGraph): void {
  const data = nodeData(graph, "adapter-daemon");
  const root = stringAt(data, "root");
  if (root !== "tools/adapter-daemon") {
    run.failures.push(
      `${graph.label}: Nx project "adapter-daemon" root is "${root ?? "missing"}", expected "tools/adapter-daemon"`,
    );
  }
  if (!Object.hasOwn(objectAt(data, "targets"), "test:integration")) {
    run.failures.push(
      `${graph.label}: Nx project "adapter-daemon" is missing required target "test:integration"`,
    );
  }
  failOnSetDrift(run, {
    where: graph.label,
    what: 'Nx dependencies for "adapter-daemon" drifted',
    actual: dependencyTargets(graph, "adapter-daemon"),
    wanted: ADAPTER_DAEMON_DEPENDENCIES.map(
      (dir) => FINAL_PACKAGES[dir].npmName,
    ),
  });
}

function nodeData(graph: NxGraph, project: string): JsonObject {
  return objectAt(objectAt(graph.nodes, project), "data");
}

function dependencyTargets(graph: NxGraph, project: string): readonly string[] {
  return arrayAt(graph.dependencies, project)
    .filter((entry) => isJsonObject(entry))
    .map((entry) => String(stringAt(entry, "target")));
}
