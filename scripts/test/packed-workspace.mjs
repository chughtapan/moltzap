/**
 * @file Packs workspace packages the way a release does and proves the packed
 * manifests form an installable closure.
 *
 * `pnpm pack` rewrites every `workspace:*` dependency to the sibling's manifest
 * version, so a consumer installing from npm resolves exactly the version the
 * same release publishes. Each package gate packs its closure through here and
 * checks the rewritten pins before it installs anything.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function requireCondition(condition, detail) {
  if (!condition) {
    throw new Error(detail);
  }
}

async function packWorkspacePackage(packageRoot, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 },
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

/**
 * Pack every package in `packageRoots` into `destination`.
 * @param {Readonly<Record<string, string>>} packageRoots Package name to source root.
 * @param {string} destination Directory that receives the tarballs.
 * @returns {Promise<Record<string, string>>} Package name to tarball path.
 */
export async function packWorkspacePackages(packageRoots, destination) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(packageRoots).map(async ([name, root]) => [
        name,
        await packWorkspacePackage(root, destination),
      ]),
    ),
  );
}

async function readPackedManifest(archive) {
  const { stdout } = await exec(
    "tar",
    ["-xOf", archive, "package/package.json"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/**
 * Read every packed manifest and prove the closure installs from a registry:
 * each manifest keeps its source name and version, carries no `private` flag,
 * and pins every packed sibling to that sibling's exact packed version.
 * @param {Readonly<Record<string, string>>} archives Package name to tarball path.
 * @param {Readonly<Record<string, string>>} packageRoots Package name to source root.
 * @returns {Promise<Record<string, Record<string, unknown>>>} Package name to packed manifest.
 */
export async function readPackedManifests(archives, packageRoots) {
  const manifests = Object.fromEntries(
    await Promise.all(
      Object.entries(archives).map(async ([name, archive]) => [
        name,
        await readPackedManifest(archive),
      ]),
    ),
  );
  for (const [name, manifest] of Object.entries(manifests)) {
    const sourceManifest = JSON.parse(
      await readFile(resolve(packageRoots[name], "package.json"), "utf8"),
    );
    requireCondition(
      manifest?.name === name && manifest.version === sourceManifest.version,
      `packed ${name} manifest identity drifted`,
    );
    requireCondition(
      manifest.private === undefined,
      `packed ${name} carries a private flag and cannot be published`,
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(
      (candidate) => candidate in archives,
    )) {
      requireCondition(
        manifest.dependencies[dependency] === manifests[dependency].version,
        `packed ${name} does not pin ${dependency} to its packed version`,
      );
    }
  }
  return manifests;
}
