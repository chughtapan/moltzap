// Overlays the MoltZap channel, eval provisioner, skill, and manifest onto an
// extracted NanoClaw checkout, then points the two MoltZap dependencies at the
// packed workspace tarballs. Runs inside the image build, where the checkout is
// already writable; the caller stages every input it reads.
//
// The manifest overlay is upstream's with two deliberate divergences carried by
// `nanoclaw-assets/package.json`: `@moltzap/{client,protocol}` are added for the
// channel, and better-sqlite3 rides the v12 line because upstream's exact 11.x
// pin has no prebuilds for current Node and its source no longer compiles
// against modern V8.

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const MOLTZAP_PACKAGES = ["@moltzap/client", "@moltzap/protocol"];
const CHANNEL_REGISTRATION = "import './moltzap.js';";
const JSON_INDENT_SPACES = 2;
const TARBALL_EXTENSION = ".tgz";

function usage() {
  throw new TypeError("usage: prepare.mjs APP_ROOT ASSETS_ROOT TARBALLS_ROOT");
}

async function overlayAssets(appRoot, assetsRoot) {
  await mkdir(join(appRoot, "container", "skills", "moltzap"), {
    recursive: true,
  });
  await Promise.all([
    copyFile(
      join(assetsRoot, "moltzap.ts"),
      join(appRoot, "src", "channels", "moltzap.ts"),
    ),
    copyFile(
      join(assetsRoot, "moltzap-eval-provision.ts"),
      join(appRoot, "src", "moltzap-eval-provision.ts"),
    ),
    copyFile(
      join(assetsRoot, "SKILL.md"),
      join(appRoot, "container", "skills", "moltzap", "SKILL.md"),
    ),
    copyFile(join(assetsRoot, "package.json"), join(appRoot, "package.json")),
    copyFile(
      join(assetsRoot, "package-lock.json"),
      join(appRoot, "package-lock.json"),
    ),
  ]);
}

// NanoClaw discovers a channel by importing it for its self-registration side
// effect, so the barrel is the one file that decides whether the MoltZap
// channel exists at all.
async function registerChannel(appRoot) {
  const barrelPath = join(appRoot, "src", "channels", "index.ts");
  const barrel = await readFile(barrelPath, "utf8");
  if (barrel.includes(CHANNEL_REGISTRATION)) {
    return;
  }
  await writeFile(
    barrelPath,
    `${barrel.trimEnd()}\n\n${CHANNEL_REGISTRATION}\n`,
  );
}

async function vendorTarballs(appRoot, tarballsRoot) {
  const vendor = join(appRoot, "vendor");
  await mkdir(vendor, { recursive: true });
  const archives = (await readdir(tarballsRoot)).filter((entry) =>
    entry.endsWith(TARBALL_EXTENSION),
  );
  await Promise.all(
    archives.map((entry) =>
      copyFile(join(tarballsRoot, entry), join(vendor, entry)),
    ),
  );
  return Object.fromEntries(
    MOLTZAP_PACKAGES.map((name) => {
      const prefix = `${name.replace("@", "").replace("/", "-")}-`;
      const archive = archives.find((entry) => entry.startsWith(prefix));
      if (archive === undefined) {
        throw new Error(`no packed workspace tarball for ${name}`);
      }
      return [name, `file:vendor/${archive}`];
    }),
  );
}

// An override as well as a dependency: the channel's own transitive resolution
// of @moltzap/protocol would otherwise come from the registry, and a published
// copy beside the packed one is exactly the drift the workspace build avoids.
async function bindWorkspaceDependencies(appRoot, specifiers) {
  const manifestPath = join(appRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const rewritten = {
    ...manifest,
    dependencies: { ...manifest.dependencies, ...specifiers },
    overrides: { ...manifest.overrides, ...specifiers },
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(rewritten, null, JSON_INDENT_SPACES)}\n`,
  );
}

const [appRoot, assetsRoot, tarballsRoot] = process.argv.slice(2);
if (
  appRoot === undefined ||
  assetsRoot === undefined ||
  tarballsRoot === undefined
) {
  usage();
}
await overlayAssets(appRoot, assetsRoot);
await registerChannel(appRoot);
await bindWorkspaceDependencies(
  appRoot,
  await vendorTarballs(appRoot, tarballsRoot),
);
