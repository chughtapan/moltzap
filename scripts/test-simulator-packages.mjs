import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(workspaceRoot, "packages", "simulator");
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-simulator-pack-"));
const forbiddenSimulatorPaths = [
  "scripts/build-server-image.mjs",
  "server-image/Dockerfile",
  "server-image/moltzap.yaml",
  "src/layer.ts",
  "src/network/server.ts",
  "src/network/server-image.ts",
  "src/runtime/cache.ts",
  "src/runtime/effect.ts",
  "src/runtime/nanoclaw/install.ts",
  "src/runtime/nanoclaw/onecli.ts",
  "src/runtime/nanoclaw/process.ts",
  "src/runtime/openclaw/cache.ts",
  "src/runtime/openclaw/process.ts",
];
const forbiddenStandaloneWorkspacePaths = [
  "examples/simulator/README.md",
  "examples/simulator/hello.ts",
  "examples/simulator/openclaw-container.mjs",
  "examples/simulator/openclaw-container.test.mjs",
  "examples/simulator/openclaw-image.json",
  "examples/simulator/package.json",
  "examples/simulator/tsconfig.json",
];
const standaloneWorkspaceControlFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "knip.json",
  "tools/workspace/project.json",
  ".github/workflows/ci.yml",
];

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

async function requirePathMissing(root, relativePath, detail) {
  try {
    await access(join(root, relativePath));
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw cause;
  }
  throw new Error(detail);
}

async function verifyRepositoryCutover() {
  await Promise.all(
    forbiddenStandaloneWorkspacePaths.map((relativePath) =>
      requirePathMissing(
        workspaceRoot,
        relativePath,
        `standalone simulator workspace path remains: ${relativePath}`,
      ),
    ),
  );
  await Promise.all(
    forbiddenSimulatorPaths.map((relativePath) =>
      requirePathMissing(
        packageRoot,
        relativePath,
        `obsolete simulator path remains in the repository: ${relativePath}`,
      ),
    ),
  );
  await Promise.all(
    standaloneWorkspaceControlFiles.map(async (relativePath) => {
      const source = await readFile(join(workspaceRoot, relativePath), "utf8");
      requireCondition(
        !source.includes("examples/simulator") &&
          !source.includes("simulator-example"),
        `standalone simulator workspace remains configured in ${relativePath}`,
      );
    }),
  );
}

async function packedTarball() {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", temporaryRoot],
    { cwd: packageRoot },
  );
  const printed = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  requireCondition(printed !== undefined, "pnpm pack returned no tarball");
  return resolve(packageRoot, printed);
}

async function verifyPackedFiles(extractedPackage) {
  const required = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/network.js",
    "dist/network.d.ts",
    "dist/ledger.js",
    "dist/ledger.d.ts",
    "dist/runtime.js",
    "dist/runtime.d.ts",
    "dist/nanoclaw-assets/SKILL.md",
    "dist/nanoclaw-assets/moltzap.ts",
  ];
  await Promise.all(
    required.map(async (relativePath) => {
      const path = join(extractedPackage, relativePath);
      await readFile(path).catch((cause) => {
        throw new Error(`packed simulator is missing ${relativePath}`, {
          cause,
        });
      });
    }),
  );
  await Promise.all(
    forbiddenSimulatorPaths.map((relativePath) =>
      requirePathMissing(
        extractedPackage,
        relativePath,
        `packed simulator contains obsolete path ${relativePath}`,
      ),
    ),
  );

  const manifest = JSON.parse(
    await readFile(join(extractedPackage, "package.json"), "utf8"),
  );
  requireCondition(
    JSON.stringify(Object.keys(manifest.exports)) ===
      JSON.stringify([".", "./network", "./ledger", "./runtime"]),
    "packed simulator exports must be root, network, ledger, and runtime",
  );
}

async function verifyConsumerImports(extractedPackage) {
  const consumerRoot = join(temporaryRoot, "consumer");
  const packageScope = join(consumerRoot, "node_modules", "@moltzap");
  await mkdir(packageScope, { recursive: true });
  await symlink(extractedPackage, join(packageScope, "simulator"), "dir");
  await symlink(
    await realpath(join(packageRoot, "node_modules")),
    join(extractedPackage, "node_modules"),
    "dir",
  );
  const checkPath = join(consumerRoot, "check.mjs");
  await writeFile(
    checkPath,
    [
      'import * as simulator from "@moltzap/simulator";',
      'import * as network from "@moltzap/simulator/network";',
      'import * as ledger from "@moltzap/simulator/ledger";',
      'import * as runtime from "@moltzap/simulator/runtime";',
      'for (const name of ["Run", "RunSpec"]) {',
      "  if (!(name in simulator)) throw new Error(`missing root export ${name}`);",
      "}",
      'for (const name of ["defineDistributedRuntime", "openClawRuntime", "nanoclawRuntime"]) {',
      "  if (!(name in runtime)) throw new Error(`missing runtime export ${name}`);",
      "}",
      'for (const name of ["simulator", "simulatorLayer"]) {',
      "  if (name in simulator) throw new Error(`obsolete root export ${name}`);",
      "}",
      'for (const name of ["defineRuntime", "effectRuntime"]) {',
      "  if (name in runtime) throw new Error(`obsolete runtime export ${name}`);",
      "}",
      'if (!("RouterProvider" in network)) throw new Error("missing network RouterProvider");',
      'if (!("LedgerStorage" in ledger)) throw new Error("missing ledger LedgerStorage");',
      "",
    ].join("\n"),
  );
  await exec(process.execPath, [checkPath], { cwd: consumerRoot });
}

try {
  await verifyRepositoryCutover();
  const tarball = await packedTarball();
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", tarball, "-C", extractedRoot]);
  const extractedPackage = join(extractedRoot, "package");
  await verifyPackedFiles(extractedPackage);
  await verifyConsumerImports(extractedPackage);
  process.stdout.write("simulator package consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
