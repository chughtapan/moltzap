import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractPackedArchive,
  installPackedConsumer,
  packWorkspaceClosure,
  requireCondition,
} from "./test/packed-workspace.mjs";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/nanoclaw-channel": join(
    workspaceRoot,
    "packages",
    "nanoclaw-channel",
  ),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
const ROOT_EXPORT = Object.freeze({
  types: "./dist/channels/moltzap.d.ts",
  import: "./dist/channels/moltzap.js",
});
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-nanoclaw-pack-"));

async function verifyPackedManifest(archive, manifest) {
  const extractedPackage = await extractPackedArchive(archive, temporaryRoot);
  requireCondition(
    manifest.main === ROOT_EXPORT.import &&
      manifest.types === ROOT_EXPORT.types,
    "packed NanoClaw main and types must match its root export",
  );
  requireCondition(
    JSON.stringify(manifest.exports) === JSON.stringify({ ".": ROOT_EXPORT }),
    "packed NanoClaw package must expose exactly its root entrypoint",
  );
  await Promise.all(
    [ROOT_EXPORT.import, ROOT_EXPORT.types].map((path) =>
      readFile(join(extractedPackage, path)).catch((cause) => {
        throw new Error(`packed NanoClaw package is missing ${path}`, {
          cause,
        });
      }),
    ),
  );
}

async function verifyConsumer(archives) {
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "moltzap-nanoclaw-packed-consumer",
    archives,
  });
  const checkPath = join(consumerRoot, "check.mjs");
  await writeFile(
    checkPath,
    [
      'const adapter = await import("@moltzap/nanoclaw-channel");',
      'if (Object.keys(adapter).sort().join(",") !== "MoltZapAdapter,makeMoltZapAdapter") {',
      '  throw new Error(`unexpected NanoClaw adapter exports: ${Object.keys(adapter).join(",")}`);',
      "}",
      "",
    ].join("\n"),
  );
  await exec(process.execPath, [checkPath], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
  });
}

try {
  const { archives, manifests } = await packWorkspaceClosure(
    packageRoots,
    temporaryRoot,
  );
  await verifyPackedManifest(
    archives["@moltzap/nanoclaw-channel"],
    manifests["@moltzap/nanoclaw-channel"],
  );
  await verifyConsumer(archives);
  process.stdout.write("NanoClaw packed consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
