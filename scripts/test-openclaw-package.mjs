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
  "@moltzap/openclaw-channel": join(
    workspaceRoot,
    "packages",
    "openclaw-channel",
  ),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
const OPENCLAW_VERSION = "2026.8.1";
const OPENCLAW_COMMIT_SHA = "ea806575e6450e4d1efdfc72c19f04be982a1b9b";
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-openclaw-pack-"));

async function verifyPackedManifest(archive, manifests) {
  const extractedPackage = await extractPackedArchive(archive, temporaryRoot);
  const manifest = manifests["@moltzap/openclaw-channel"];
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
      manifests["@moltzap/client"].version,
    "packed OpenClaw package must use the packed Client version",
  );
  requireCondition(
    manifest.peerDependencies?.openclaw === OPENCLAW_VERSION &&
      manifest.peerDependenciesMeta?.openclaw?.optional === true,
    "packed OpenClaw host peer must remain exact and optional",
  );
  requireCondition(
    JSON.stringify(manifest.openclaw?.extensions) ===
      JSON.stringify(["./dist/plugin.js"]),
    "packed OpenClaw discovery entry drifted",
  );
  await Promise.all(
    [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/plugin.js",
      "dist/plugin.d.ts",
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
  const bundledPluginRoot = join(extensionsRoot, "openclaw-channel");
  const bundledDependenciesRoot = join(extensionsRoot, "node_modules");
  await cp(channelRoot, bundledPluginRoot, { recursive: true });
  await symlink(
    join(consumerRoot, "node_modules"),
    bundledDependenciesRoot,
    "dir",
  );
  return {
    bundledPluginRoot,
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
  const { bundledPluginRoot, openclawRoot } =
    await assembleBundledPlugin(consumerRoot);
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
    "const extension = await import(pathToFileURL(plugin.source).href);",
    'requireCondition(extension.default?.id === "openclaw-channel", "bundled discovery source is not the MoltZap loader entry");',
    "let registered;",
    "extension.default.register({",
    "  runtime: {},",
    "  registerChannel: ({ plugin: channel }) => { registered = channel; },",
    "});",
    'requireCondition(registered?.id === "moltzap", "bundled loader did not register the MoltZap channel");',
    'requireCondition(registered?.message?.send?.text, "stable OpenClaw did not register the MoltZap message adapter");',
    'requireCondition(extension.default.channelPlugin === registered, "stable OpenClaw channel entry did not expose the registered plugin");',
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
        MOLTZAP_OPENCLAW_BUNDLED_PLUGIN_ROOT: bundledPluginRoot,
        MOLTZAP_OPENCLAW_PLUGIN_LIST_COMMAND:
          await openClawPluginListCommand(openclawRoot),
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function verifyConsumer(archives) {
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "moltzap-openclaw-packed-consumer",
    archives,
    dependencies: { effect: "3.22.0", openclaw: OPENCLAW_VERSION },
    devDependencies: { typescript: "6.0.2" },
  });
  await Promise.all([
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
    join(consumerRoot, "node_modules", ".bin", "tsc"),
    ["--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  await verifyBundledHost(consumerRoot);
}

try {
  const { archives, manifests } = await packWorkspaceClosure(
    packageRoots,
    temporaryRoot,
  );
  await verifyPackedManifest(archives["@moltzap/openclaw-channel"], manifests);
  await verifyConsumer(archives);
  process.stdout.write("OpenClaw packed consumer check passed\n");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
