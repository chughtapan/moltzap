/** @file Installs the narrow MoltZap source overlay into an extracted NanoClaw tree. */
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [appRoot, channelSource, ...archives] = process.argv.slice(2);
if (
  appRoot === undefined ||
  channelSource === undefined ||
  archives.length !== 3
) {
  throw new TypeError(
    "usage: prepare.mjs APP_ROOT CHANNEL_SOURCE PACKAGE_ARCHIVE...",
  );
}

await copyFile(channelSource, join(appRoot, "src/channels/moltzap.ts"));
const packagePath = join(appRoot, "package.json");
const manifest = JSON.parse(await readFile(packagePath, "utf8"));
const [clientArchive, identityArchive, routerArchive] = archives;
delete manifest.scripts.prepare;
manifest.dependencies = {
  ...manifest.dependencies,
  "@modelcontextprotocol/client": "2.0.0-beta.5",
  "@moltzap/client": `file:${clientArchive}`,
  "@moltzap/identity": `file:${identityArchive}`,
  "@moltzap/router": `file:${routerArchive}`,
  effect: "^3.22.0",
};
manifest.pnpm = {
  ...manifest.pnpm,
  overrides: {
    ...manifest.pnpm?.overrides,
    "@moltzap/client": `file:${clientArchive}`,
    "@moltzap/identity": `file:${identityArchive}`,
    "@moltzap/router": `file:${routerArchive}`,
  },
};
for (const [name, value] of Object.entries(manifest.dependencies)) {
  if (typeof value !== "string" || value.includes("undefined")) {
    throw new Error(`missing staged dependency archive for ${name}`);
  }
}
await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

const workspacePath = join(appRoot, "pnpm-workspace.yaml");
const workspace = await readFile(workspacePath, "utf8");
if (!workspace.includes("  - better-sqlite3\n")) {
  const updatedWorkspace = workspace.replace(
    "onlyBuiltDependencies:\n",
    "onlyBuiltDependencies:\n  - better-sqlite3\n",
  );
  if (updatedWorkspace === workspace) {
    throw new Error("NanoClaw workspace has no onlyBuiltDependencies list");
  }
  await writeFile(workspacePath, updatedWorkspace);
}
