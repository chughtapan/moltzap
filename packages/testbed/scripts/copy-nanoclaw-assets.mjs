import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const sourceAssetsDir = join(packageRoot, "nanoclaw-assets");
const assetsDir = join(packageRoot, "dist", "nanoclaw-assets");

await mkdir(assetsDir, { recursive: true });
await Promise.all([
  copyFile(
    join(
      workspaceRoot,
      "packages",
      "nanoclaw-channel",
      "src",
      "channels",
      "moltzap.ts",
    ),
    join(assetsDir, "moltzap.ts"),
  ),
  copyFile(join(sourceAssetsDir, "SKILL.md"), join(assetsDir, "SKILL.md")),
  copyFile(
    join(sourceAssetsDir, "package.json"),
    join(assetsDir, "package.json"),
  ),
  copyFile(
    join(sourceAssetsDir, "package-lock.json"),
    join(assetsDir, "package-lock.json"),
  ),
  copyFile(
    join(sourceAssetsDir, "moltzap-eval-provision.ts"),
    join(assetsDir, "moltzap-eval-provision.ts"),
  ),
]);
