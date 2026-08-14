import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/openclaw-channel": join(
    workspaceRoot,
    "packages",
    "openclaw-channel",
  ),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
const productDependencyGraph = Object.freeze({
  "@moltzap/client": Object.freeze(["@moltzap/identity", "@moltzap/router"]),
  "@moltzap/identity": Object.freeze([]),
  "@moltzap/openclaw-channel": Object.freeze(["@moltzap/client"]),
  "@moltzap/router": Object.freeze(["@moltzap/identity"]),
});
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-openclaw-pack-"));

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

async function packedArchives() {
  const destination = join(temporaryRoot, "tarballs");
  await mkdir(destination);
  return Object.fromEntries(
    await Promise.all(
      Object.entries(packageRoots).map(async ([name, packageRoot]) => [
        name,
        await packWorkspacePackage(packageRoot, destination),
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

async function verifyPackedProductGraph(archives) {
  const manifests = Object.fromEntries(
    await Promise.all(
      Object.entries(archives).map(async ([name, archive]) => [
        name,
        await readPackedManifest(archive),
      ]),
    ),
  );
  for (const [name, expectedDependencies] of Object.entries(
    productDependencyGraph,
  )) {
    const manifest = manifests[name];
    const sourceManifest = JSON.parse(
      await readFile(join(packageRoots[name], "package.json"), "utf8"),
    );
    requireCondition(
      manifest?.name === name && manifest.version === sourceManifest.version,
      `packed ${name} manifest identity drifted`,
    );
    requireCondition(
      manifest.private === sourceManifest.private,
      `packed ${name} manifest changed its current private-package status`,
    );
    const actualDependencies = Object.keys(manifest.dependencies ?? {})
      .filter((dependency) => dependency.startsWith("@moltzap/"))
      .sort();
    requireCondition(
      JSON.stringify(actualDependencies) ===
        JSON.stringify([...expectedDependencies].sort()),
      `packed ${name} product dependency graph drifted`,
    );
    for (const dependency of expectedDependencies) {
      requireCondition(
        archives[dependency] !== undefined &&
          manifest.dependencies[dependency] === manifests[dependency].version,
        `packed ${name} does not resolve ${dependency} to its packed version`,
      );
    }
  }
  return manifests;
}

async function verifyPackedManifest(archive, manifests) {
  const extractedRoot = join(temporaryRoot, "extracted");
  await mkdir(extractedRoot);
  await exec("tar", ["-xzf", archive, "-C", extractedRoot]);
  const extractedPackage = join(extractedRoot, "package");
  const manifest = manifests["@moltzap/openclaw-channel"];
  requireCondition(
    manifest.name === "@moltzap/openclaw-channel",
    "packed OpenClaw manifest has the wrong package name",
  );
  requireCondition(
    manifest.main === "./dist/index.js" &&
      manifest.types === "./dist/index.d.ts",
    "packed OpenClaw main and types must match its root export",
  );
  requireCondition(
    JSON.stringify(manifest.exports) ===
      JSON.stringify({
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      }),
    "packed OpenClaw package must expose exactly its root entrypoint",
  );
  requireCondition(
    manifest.dependencies?.["@moltzap/client"] ===
      manifests["@moltzap/client"].version &&
      Object.keys(manifest.dependencies ?? {}).every(
        (name) => name === "@moltzap/client" || name === "effect",
      ),
    "packed OpenClaw package has an unexpected product dependency",
  );
  requireCondition(
    manifest.peerDependencies?.openclaw === ">=2026.0.0" &&
      manifest.peerDependenciesMeta?.openclaw?.optional === true,
    "packed OpenClaw host peer must remain optional",
  );
  requireCondition(
    JSON.stringify(manifest.openclaw?.extensions) ===
      JSON.stringify(["./dist/openclaw-entry.js"]),
    "packed OpenClaw discovery entry drifted",
  );
  await Promise.all(
    [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/openclaw-entry.js",
      "dist/openclaw-entry.d.ts",
      "openclaw.plugin.json",
    ].map((path) => readFile(join(extractedPackage, path))),
  );
  const pluginManifest = JSON.parse(
    await readFile(join(extractedPackage, "openclaw.plugin.json"), "utf8"),
  );
  requireCondition(
    pluginManifest.id === "openclaw-channel" &&
      JSON.stringify(pluginManifest.channels) === JSON.stringify(["moltzap"]),
    "packed OpenClaw discovery manifest drifted",
  );
}

function archiveSpecifier(consumerRoot, archive) {
  return `file:${relative(consumerRoot, archive)}`;
}

async function verifyIsolatedInstall(consumerRoot) {
  const installedRoot = await realpath(consumerRoot);
  const lockfile = await readFile(join(consumerRoot, "pnpm-lock.yaml"), "utf8");
  requireCondition(
    !lockfile.includes(workspaceRoot) &&
      !lockfile.includes("workspace:") &&
      !lockfile.includes("link:"),
    "packed consumer lockfile escaped to a workspace or linked dependency",
  );
  for (const packageName of [
    "@moltzap/client",
    "@moltzap/identity",
    "@moltzap/openclaw-channel",
    "@moltzap/router",
    "effect",
    "typescript",
  ]) {
    const installed = await realpath(
      join(consumerRoot, "node_modules", ...packageName.split("/")),
    );
    requireCondition(
      installed.startsWith(`${installedRoot}/`),
      `packed consumer resolved ${packageName} outside its isolated install`,
    );
  }
}

async function verifyConsumer(archives) {
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);
  const localPackages = Object.fromEntries(
    Object.entries(archives).map(([name, archive]) => [
      name,
      archiveSpecifier(consumerRoot, archive),
    ]),
  );
  await Promise.all([
    writeFile(
      join(consumerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "moltzap-openclaw-packed-consumer",
          version: "0.0.0",
          private: true,
          type: "module",
          dependencies: {
            ...localPackages,
            effect: "3.22.0",
          },
          devDependencies: { typescript: "6.0.2" },
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
          ([name, archive]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(archive)}`,
        ),
        "",
      ].join("\n"),
    ),
    writeFile(
      join(consumerRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            lib: ["ES2023", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2023",
            verbatimModuleSyntax: true,
          },
          include: ["check.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(consumerRoot, "check.ts"),
      [
        'import plugin, { createMoltzapChannelPlugin, moltzapChannelPlugin, type MoltzapChannelPlugin } from "@moltzap/openclaw-channel";',
        "const constructed: MoltzapChannelPlugin = createMoltzapChannelPlugin();",
        "const singleton: MoltzapChannelPlugin = moltzapChannelPlugin;",
        "void [plugin, constructed, singleton];",
        "",
      ].join("\n"),
    ),
  ]);
  await exec(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  await verifyIsolatedInstall(consumerRoot);
  await exec(
    join(consumerRoot, "node_modules", ".bin", "tsc"),
    ["--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const runtimeCheck = join(consumerRoot, "runtime-check.mjs");
  await writeFile(
    runtimeCheck,
    [
      'import { readFile } from "node:fs/promises";',
      'const packageRoot = new URL("./node_modules/@moltzap/openclaw-channel/", import.meta.url);',
      'const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));',
      'const discovery = JSON.parse(await readFile(new URL("openclaw.plugin.json", packageRoot), "utf8"));',
      'const api = await import("@moltzap/openclaw-channel");',
      'const expected = ["createMoltzapChannelPlugin", "default", "moltzapChannelPlugin"];',
      "const actual = Object.keys(api).sort();",
      'if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`OpenClaw runtime exports drifted: ${actual.join(", ")}`);',
      'if (api.default.id !== "openclaw-channel") throw new Error("OpenClaw default plugin id drifted");',
      'if (api.moltzapChannelPlugin.id !== "moltzap") throw new Error("MoltZap channel id drifted");',
      'if (JSON.stringify(manifest.openclaw?.extensions) !== JSON.stringify(["./dist/openclaw-entry.js"])) throw new Error("OpenClaw discovery entry drifted");',
      'if (discovery.id !== api.default.id || JSON.stringify(discovery.channels) !== JSON.stringify([api.moltzapChannelPlugin.id])) throw new Error("OpenClaw discovery manifest does not describe the runtime plugin");',
      "const extension = await import(new URL(manifest.openclaw.extensions[0], packageRoot));",
      'if (extension.default !== api.default) throw new Error("OpenClaw discovery entry does not expose the package plugin");',
      "let registered;",
      "extension.default.register({ registerChannel: ({ plugin }) => { registered = plugin; } });",
      'if (registered !== api.moltzapChannelPlugin) throw new Error("OpenClaw discovery entry registered the wrong channel");',
      "",
    ].join("\n"),
  );
  await exec(process.execPath, [runtimeCheck], {
    cwd: consumerRoot,
    env: { ...process.env, NODE_PATH: undefined },
    maxBuffer: 16 * 1024 * 1024,
  });
}

try {
  const archives = await packedArchives();
  const manifests = await verifyPackedProductGraph(archives);
  await verifyPackedManifest(archives["@moltzap/openclaw-channel"], manifests);
  await verifyConsumer(archives);
  process.stdout.write("OpenClaw packed consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
