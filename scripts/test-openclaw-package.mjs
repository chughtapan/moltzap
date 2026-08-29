import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
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
const OPENCLAW_VERSION = "2026.6.34";
const OPENCLAW_COMMIT_SHA = "5c38f996d4059ebd9080cf74dc611ec3a17f4d50";
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
    manifest.peerDependencies?.openclaw === OPENCLAW_VERSION &&
      manifest.peerDependenciesMeta?.openclaw?.optional === true,
    "packed OpenClaw host peer must remain exact and optional",
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
    "openclaw",
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

async function verifyStableOpenClaw(openclawRoot) {
  const [manifestSource, buildInfoSource] = await Promise.all([
    readFile(join(openclawRoot, "package.json"), "utf8"),
    readFile(join(openclawRoot, "dist", "build-info.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const buildInfo = JSON.parse(buildInfoSource);
  requireCondition(
    manifest.version === OPENCLAW_VERSION &&
      buildInfo.version === OPENCLAW_VERSION &&
      buildInfo.commit === OPENCLAW_COMMIT_SHA,
    "installed OpenClaw host does not match the pinned source",
  );
}

async function assembleBundledPlugin(consumerRoot) {
  const channelRoot = await realpath(
    join(consumerRoot, "node_modules", "@moltzap", "openclaw-channel"),
  );
  const openclawRoot = await realpath(
    join(consumerRoot, "node_modules", "openclaw"),
  );
  await verifyStableOpenClaw(openclawRoot);

  const extensionsRoot = join(openclawRoot, "dist", "extensions");
  const extensionNames = await readdir(extensionsRoot);
  requireCondition(
    !extensionNames.includes("openclaw-channel") &&
      !extensionNames.includes("node_modules"),
    "stable OpenClaw unexpectedly reserves the MoltZap bundled paths",
  );
  const bundledPluginRoot = join(extensionsRoot, "openclaw-channel");
  const bundledDependenciesRoot = join(extensionsRoot, "node_modules");
  await cp(channelRoot, bundledPluginRoot, { recursive: true });
  await symlink(
    join(consumerRoot, "node_modules"),
    bundledDependenciesRoot,
    "dir",
  );
  return {
    bundledDependenciesRoot,
    bundledPluginRoot,
    channelRoot,
    openclawRoot,
  };
}

async function openClawPluginListCommand(openclawRoot) {
  const candidates = (await readdir(join(openclawRoot, "dist"))).filter(
    (name) => /^plugins-list-command-[A-Za-z0-9_-]+\.js$/.test(name),
  );
  requireCondition(
    candidates.length === 1,
    `stable OpenClaw exposes ${String(candidates.length)} plugin-list commands`,
  );
  return join(openclawRoot, "dist", candidates[0]);
}

async function verifyBundledHost(consumerRoot) {
  const {
    bundledDependenciesRoot,
    bundledPluginRoot,
    channelRoot,
    openclawRoot,
  } = await assembleBundledPlugin(consumerRoot);
  const stateRoot = join(consumerRoot, "openclaw-state");
  const configPath = join(stateRoot, "openclaw.json");
  await mkdir(stateRoot);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        channels: {
          moltzap: {
            accounts: [{ id: "simulator-agent" }],
          },
        },
        plugins: {
          entries: { "openclaw-channel": { enabled: true } },
        },
      },
      null,
      2,
    )}\n`,
  );

  const runtimeCheck = [
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "function requireCondition(condition, detail) {",
    "  if (!condition) throw new Error(detail);",
    "}",
    "const command = await import(pathToFileURL(process.env.MOLTZAP_OPENCLAW_PLUGIN_LIST_COMMAND).href);",
    "const output = [];",
    "await command.runPluginsListCommand(",
    "  { enabled: false, json: true, verbose: false },",
    "  {",
    "    log: (value) => { output.push(value); },",
    '    error: (...values) => { throw new Error(values.join(" ")); },',
    "    exit: (code) => { throw new Error(`plugin list exited ${String(code)}`); },",
    "  },",
    ");",
    'requireCondition(output.length === 1 && typeof output[0] === "string", "OpenClaw plugin list did not emit one JSON report");',
    "const report = JSON.parse(output[0]);",
    'requireCondition(report.registry?.source === "derived", "OpenClaw did not derive discovery from its packaged tree");',
    'const plugin = report.plugins.find((candidate) => candidate.id === "openclaw-channel");',
    'requireCondition(plugin?.origin === "bundled" && plugin.enabled === true && plugin.status === "loaded", "MoltZap was not admitted as an enabled bundled plugin");',
    'requireCondition(typeof plugin.rootDir === "string" && typeof plugin.source === "string" && plugin.rootDir === process.env.MOLTZAP_OPENCLAW_BUNDLED_PLUGIN_ROOT && plugin.source.startsWith(`${plugin.rootDir}/`), "MoltZap discovery escaped its bundled root");',
    'requireCondition(JSON.stringify(plugin.channelIds) === JSON.stringify(["moltzap"]), "MoltZap bundled channel metadata drifted");',
    "const dependenciesRoot = process.env.MOLTZAP_OPENCLAW_BUNDLED_DEPENDENCIES_ROOT;",
    'requireCondition(typeof dependenciesRoot === "string", "bundled dependency root is not configured");',
    'requireCondition(report.plugins.every((candidate) => typeof candidate.rootDir !== "string" || (candidate.rootDir !== dependenciesRoot && !candidate.rootDir.startsWith(`${dependenciesRoot}/`))), "OpenClaw discovered the sibling node_modules mount as a plugin");',
    'const packageApi = await import(pathToFileURL(join(process.env.MOLTZAP_OPENCLAW_CHANNEL_ROOT, "dist", "index.js")).href);',
    'requireCondition(JSON.stringify(Object.keys(packageApi)) === JSON.stringify(["default"]), "OpenClaw package root exports more than its loader entry");',
    "const extension = await import(pathToFileURL(plugin.source).href);",
    'requireCondition(extension.default?.id === "openclaw-channel", "bundled discovery source is not the MoltZap loader entry");',
    "const uncalled = (name) => () => { throw new Error(`registration called ${name}`); };",
    "let registered;",
    "extension.default.register({",
    "  runtime: {",
    "    channel: {",
    '      inbound: { buildContext: uncalled("inbound.buildContext"), run: uncalled("inbound.run") },',
    '      reply: { dispatchReplyWithBufferedBlockDispatcher: uncalled("reply.dispatch") },',
    '      routing: { resolveAgentRoute: uncalled("routing.resolveAgentRoute") },',
    '      session: { recordInboundSession: uncalled("session.recordInboundSession") },',
    "    },",
    "  },",
    "  registerChannel: ({ plugin: channel }) => { registered = channel; },",
    "});",
    'requireCondition(registered?.id === "moltzap", "bundled loader did not register the MoltZap channel");',
    'requireCondition(registered?.message?.send?.text, "stable OpenClaw did not register the MoltZap message adapter");',
    "",
  ].join("\n");
  await exec(
    process.execPath,
    ["--input-type=module", "--eval", runtimeCheck],
    {
      cwd: consumerRoot,
      env: {
        ...process.env,
        HOME: stateRoot,
        USERPROFILE: stateRoot,
        NODE_PATH: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_HOME: stateRoot,
        OPENCLAW_STATE_DIR: stateRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        VITEST: undefined,
        MOLTZAP_OPENCLAW_BUNDLED_DEPENDENCIES_ROOT: bundledDependenciesRoot,
        MOLTZAP_OPENCLAW_BUNDLED_PLUGIN_ROOT: bundledPluginRoot,
        MOLTZAP_OPENCLAW_CHANNEL_ROOT: channelRoot,
        MOLTZAP_OPENCLAW_PLUGIN_LIST_COMMAND:
          await openClawPluginListCommand(openclawRoot),
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
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
            openclaw: OPENCLAW_VERSION,
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
        'import plugin from "@moltzap/openclaw-channel";',
        "const pluginId: string = plugin.id;",
        "void pluginId;",
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
  await verifyBundledHost(consumerRoot);
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
