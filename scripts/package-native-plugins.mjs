/**
 * @file Produces private remote receiver assets from the same Client release,
 * without publishing a new npm product or packaging an owner's configuration.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeFiles = [
  "bin/receive.mjs",
  "dist/run.js",
  "dist/native/index.js",
  "dist/instinct/index.js",
  "dist/grokbot/index.js",
  "README.md",
  "bin/install-prompt.mjs",
  "dist/muse/index.js",
  "install.md",
  "muse/README.md",
  "muse/install.md",
  "muse/skills/muse/SKILL.md",
  "instinct/install.md",
  "grokbot/install.md",
  "openclaw/install.md",
  "openai-dot/install.md",
  "remote/README.md",
  "remote/receive.service",
  "remote/receive.env.example",
  "remote/callback.conf.example",
];

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await packageNativePlugins(workspaceRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/**
 * Packs an explicit runtime file set with exact dependency versions. No source,
 * platform account binding, host configuration or dependency directory can
 * enter through a recursive copy. The resulting package stays private and has
 * no exported SDK or command registration. Release publication is separate.
 *
 * @param {string} root Source workspace, with the native assets already built.
 * @param {string} [destination] Owned archive output; the default is outside the cached compiled-assets directory.
 * @returns {Promise<{archive: string, sha256: string}>} Archive and content digest.
 */
export async function packageNativePlugins(
  root,
  destination = join(root, "dist/artifacts/native-plugins"),
) {
  const [native, client, workspace, nodeVersion] = await Promise.all([
    readManifest(join(root, "plugins/package.json")),
    readManifest(join(root, "packages/client/package.json")),
    readManifest(join(root, "package.json")),
    readFile(join(root, ".node-version"), "utf8"),
  ]);
  const manifest = receiverManifest(
    native,
    client,
    workspace,
    nodeVersion.trim(),
  );
  const staging = await mkdtemp(join(tmpdir(), "moltzap-native-package-"));
  try {
    await copyRuntimeFiles(root, staging);
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const output = resolve(destination);
    await mkdir(output, { recursive: true });
    await exec("pnpm", ["pack", "--pack-destination", output], {
      cwd: staging,
    });
    const archive = join(
      output,
      `moltzap-native-plugins-${manifest.version}.tgz`,
    );
    const sha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await writeFile(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
    return { archive, sha256 };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * @param {string} path Trusted source manifest path.
 * @returns {Promise<Record<string, unknown>>} Manifest whose consumed fields are checked at composition.
 */
async function readManifest(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "manifest must be an object",
  );
  return value;
}

/**
 * @param {Record<string, unknown>} native Private native build metadata.
 * @param {Record<string, unknown>} client Client release metadata.
 * @param {Record<string, unknown>} workspace Workspace toolchain metadata.
 * @param {string} nodeVersion Pinned build runtime.
 * @returns {object} Standalone receiver metadata, not a publication declaration.
 */
function receiverManifest(native, client, workspace, nodeVersion) {
  assert.equal(native.name, "@moltzap/native-plugins");
  assert.equal(native.private, true);
  assert.equal(native.version, undefined);
  assert.equal(native.exports, undefined);
  assert.equal(client.name, "@moltzap/client");
  assert.match(client.version, /^\d{4}\.\d{3,4}\.\d+$/u);
  assert.match(nodeVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(typeof workspace.packageManager, "string");
  assert.ok(
    native.dependencies &&
      typeof native.dependencies === "object" &&
      !Array.isArray(native.dependencies),
  );
  const dependencies = {
    ...native.dependencies,
    "@moltzap/client": client.version,
  };
  for (const version of Object.values(dependencies)) {
    assert.equal(typeof version, "string");
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u);
  }
  return {
    name: native.name,
    version: client.version,
    private: true,
    type: "module",
    description:
      "Remote native receive assets; not an npm product or adapter SDK",
    license: "Apache-2.0",
    packageManager: workspace.packageManager,
    engines: { node: `>=${nodeVersion}` },
    files: [...runtimeFiles, "LICENSE", "NOTICE"],
    dependencies,
  };
}

/**
 * Copies only known regular-file build inputs and rejects symlinked paths.
 * The build assumes a trusted, stable source checkout; these input checks do
 * not isolate a concurrent process with authority to rewrite the checkout.
 * @param {string} root Source workspace.
 * @param {string} staging Owned private staging directory.
 * @returns {Promise<void>}
 */
async function copyRuntimeFiles(root, staging) {
  const physicalRoot = await realpath(root);
  const files = [
    ...runtimeFiles.map((file) => ({
      source: join(physicalRoot, "plugins", file),
      target: file,
    })),
    ...["LICENSE", "NOTICE"].map((file) => ({
      source: join(physicalRoot, file),
      target: file,
    })),
  ];
  for (const { source, target } of files) {
    assert.ok(
      (await lstat(source)).isFile(),
      "native archive input must be a regular file",
    );
    assert.equal(
      await realpath(source),
      source,
      "native archive input cannot traverse a symlink",
    );
    await mkdir(dirname(join(staging, target)), { recursive: true });
    await cp(source, join(staging, target));
  }
}
