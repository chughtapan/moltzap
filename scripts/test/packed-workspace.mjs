/**
 * @file Packs workspace packages the way a release does and proves the packed
 * closure installs into an isolated consumer.
 *
 * `pnpm pack` rewrites every `workspace:*` dependency to the sibling's manifest
 * version, so a consumer installing from npm resolves exactly the version the
 * same release publishes. Each package gate packs its closure through here,
 * checks the rewritten pins, installs the tarballs into a private consumer
 * project, and then runs only its package-specific assertions.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Throw `detail` unless `condition` holds.
 * @param {boolean} condition Checked fact.
 * @param {string} detail Failure message.
 */
export function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

async function packWorkspacePackage(packageRoot, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageRoot, maxBuffer: MAX_BUFFER },
  );
  const printed = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  requireCondition(printed !== undefined, "pnpm pack returned no archive");
  return resolve(packageRoot, printed);
}

async function readPackedManifest(archive) {
  const { stdout } = await exec(
    "tar",
    ["-xOf", archive, "package/package.json"],
    { maxBuffer: MAX_BUFFER },
  );
  return JSON.parse(stdout);
}

async function listPackedFiles(archive) {
  const { stdout } = await exec("tar", ["-tzf", archive], {
    maxBuffer: MAX_BUFFER,
  });
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * Pack every package in `packageRoots` under `temporaryRoot/tarballs` and
 * prove the packed manifests form a registry-installable closure: each keeps
 * its source name and version, carries no `private` flag, ships every
 * executable its `bin` map names, and pins every packed sibling to that
 * sibling's exact packed version.
 * @param {Readonly<Record<string, string>>} packageRoots Package name to source root.
 * @param {string} temporaryRoot Scratch directory owned by the caller.
 * @returns {Promise<{ archives: Record<string, string>, manifests: Record<string, Record<string, unknown>> }>}
 * Package name to tarball path and to packed manifest.
 */
export async function packWorkspaceClosure(packageRoots, temporaryRoot) {
  const destination = join(temporaryRoot, "tarballs");
  await mkdir(destination);
  const packed = await Promise.all(
    Object.entries(packageRoots).map(async ([name, root]) => {
      const archive = await packWorkspacePackage(root, destination);
      const [manifest, files, source] = await Promise.all([
        readPackedManifest(archive),
        listPackedFiles(archive),
        readFile(join(root, "package.json"), "utf8"),
      ]);
      return {
        name,
        archive,
        manifest,
        files,
        sourceManifest: JSON.parse(source),
      };
    }),
  );
  const manifests = Object.fromEntries(
    packed.map(({ name, manifest }) => [name, manifest]),
  );
  for (const { name, manifest, files, sourceManifest } of packed) {
    requireCondition(
      manifest?.name === name && manifest.version === sourceManifest.version,
      `packed ${name} manifest identity drifted`,
    );
    requireCondition(
      manifest.private === undefined,
      `packed ${name} carries a private flag and cannot be published`,
    );
    for (const [executable, target] of Object.entries(manifest.bin ?? {})) {
      requireCondition(
        typeof target === "string" &&
          files.has(`package/${target.replace(/^\.\//u, "")}`),
        `packed ${name} does not ship its ${executable} executable at ${String(target)}`,
      );
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(
      (candidate) => candidate in manifests,
    )) {
      requireCondition(
        manifest.dependencies[dependency] === manifests[dependency].version,
        `packed ${name} does not pin ${dependency} to its packed version`,
      );
    }
  }
  return {
    archives: Object.fromEntries(
      packed.map(({ name, archive }) => [name, archive]),
    ),
    manifests,
  };
}

/**
 * Extract one tarball under `temporaryRoot/extracted` and return the package
 * directory inside it.
 * @param {string} archive Tarball path.
 * @param {string} temporaryRoot Scratch directory owned by the caller.
 * @returns {Promise<string>} The extracted `package/` directory.
 */
export async function extractPackedArchive(archive, temporaryRoot) {
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", archive, "-C", extractedRoot]);
  return join(extractedRoot, "package");
}

async function verifyIsolatedInstall(
  consumerRoot,
  packageNames,
  workspaceRoot,
) {
  const installedRoot = await realpath(consumerRoot);
  const lockfile = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
  requireCondition(
    !lockfile.includes(workspaceRoot) &&
      !lockfile.includes("workspace:") &&
      !lockfile.includes("link:"),
    "packed consumer lockfile escaped to a workspace or linked dependency",
  );
  await Promise.all(
    packageNames.map(async (packageName) => {
      const installed = await realpath(
        join(consumerRoot, "node_modules", ...packageName.split("/")),
      );
      requireCondition(
        installed.startsWith(`${installedRoot}/`),
        `packed consumer resolved ${packageName} outside its isolated install`,
      );
    }),
  );
}

/**
 * Create a consumer project under `temporaryRoot/consumer` that depends on
 * the packed tarballs plus `dependencies`, install it with the tarballs
 * overriding every workspace name, and prove each declared package resolved
 * inside that project rather than back into the workspace.
 * @param {object} input Consumer description.
 * @param {string} input.temporaryRoot Scratch directory owned by the caller.
 * @param {string} input.workspaceRoot Source workspace the install must not reach.
 * @param {string} input.name Consumer package name.
 * @param {Readonly<Record<string, string>>} input.archives Package name to tarball path.
 * @param {Readonly<Record<string, string>>} [input.dependencies] Registry dependencies.
 * @param {Readonly<Record<string, string>>} [input.devDependencies] Registry dev dependencies.
 * @returns {Promise<string>} The consumer directory.
 */
export async function installPackedConsumer({
  temporaryRoot,
  workspaceRoot,
  name,
  archives,
  dependencies = {},
  devDependencies = {},
}) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  const localPackages = Object.fromEntries(
    Object.entries(archives).map(([packageName, archive]) => [
      packageName,
      `file:${relative(consumerRoot, archive)}`,
    ]),
  );
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name,
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: { ...localPackages, ...dependencies },
          ...(Object.keys(devDependencies).length === 0
            ? {}
            : { devDependencies }),
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "pnpm-workspace.yaml"),
      [
        'packages: ["."]',
        "overrides:",
        ...Object.entries(localPackages).map(
          ([packageName, specifier]) =>
            `  ${JSON.stringify(packageName)}: ${JSON.stringify(specifier)}`,
        ),
        "",
      ].join("\n"),
    ),
  ]);
  await exec(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: consumerRoot, maxBuffer: MAX_BUFFER },
  );
  await verifyIsolatedInstall(
    consumerRoot,
    [
      ...Object.keys(archives),
      ...Object.keys(dependencies),
      ...Object.keys(devDependencies),
    ],
    workspaceRoot,
  );
  return consumerRoot;
}
