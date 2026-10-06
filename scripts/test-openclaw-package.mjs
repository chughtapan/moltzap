/**
 * @file Proves the packed `@moltzap/openclaw-channel` works in the OpenClaw
 * release it is tested against, the way a deployment uses it.
 *
 * It packs the channel's closure as a release does, installs the tarballs and
 * that OpenClaw into an isolated consumer, and checks three behaviours: the
 * package typechecks for a TypeScript consumer, OpenClaw loads it from its
 * install path and registers the `moltzap` channel, and OpenClaw serves the
 * packed group-messaging skill to the model. Every check goes through the
 * channel's public entry point or OpenClaw's CLI, so a new OpenClaw release
 * changes only the channel's `devDependencies.openclaw`.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  requireCondition,
} from "./test/packed-workspace.mjs";

const exec = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const channelRoot = join(workspaceRoot, "packages", "openclaw-channel");
const packageRoots = Object.freeze({
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/openclaw-channel": channelRoot,
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
});
/** The OpenClaw release the channel is built and tested against. */
const OPENCLAW_VERSION = JSON.parse(
  await readFile(join(channelRoot, "package.json"), "utf8"),
).devDependencies.openclaw;
const temporaryRoot = await mkdtemp(join(tmpdir(), "moltzap-openclaw-pack-"));

/**
 * Requires that a TypeScript consumer compiles against the packed entry point.
 * @param {string} consumerRoot Directory the packed closure is installed in.
 * @returns {Promise<void>}
 */
async function verifyTypes(consumerRoot) {
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2023",
      },
      include: ["check.ts"],
    })}\n`,
  );
  await writeFile(
    join(consumerRoot, "check.ts"),
    'import plugin from "@moltzap/openclaw-channel";\nconst pluginId: string = plugin.id;\nvoid pluginId;\n',
  );
  await exec(
    join(consumerRoot, "node_modules", ".bin", "tsc"),
    ["--project", join(consumerRoot, "tsconfig.json")],
    { cwd: consumerRoot, maxBuffer: MAX_BUFFER },
  );
}

/**
 * Configures an isolated OpenClaw host that loads the channel by path, as the
 * agent image does. The consumer install skipped every lifecycle script, and
 * OpenClaw's CLI refuses to start from a package whose postinstall never ran,
 * so this runs OpenClaw's own. pnpm installs package files as hard links into
 * its store, and OpenClaw silently skips a plugin whose files are hard links,
 * so the channel's files are rewritten as plain files first, as an `npm`
 * install leaves them.
 * @param {string} consumerRoot Directory the packed closure is installed in.
 * @returns {Promise<{ openclaw: (args: string[]) => Promise<any>, pluginRoot: string }>}
 *   A runner for OpenClaw CLI commands that print JSON, and the channel's root.
 */
async function pluginHost(consumerRoot) {
  const pluginRoot = await realpath(
    join(consumerRoot, "node_modules", "@moltzap", "openclaw-channel"),
  );
  const openclawRoot = await realpath(
    join(consumerRoot, "node_modules", "openclaw"),
  );
  for (const entry of await readdir(pluginRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      const content = await readFile(file);
      await rm(file);
      await writeFile(file, content);
    }
  }
  const { scripts } = JSON.parse(
    await readFile(join(openclawRoot, "package.json"), "utf8"),
  );
  await exec("sh", ["-c", scripts.postinstall], {
    cwd: openclawRoot,
    maxBuffer: MAX_BUFFER,
  });
  const stateRoot = join(consumerRoot, "openclaw-state");
  const configPath = join(stateRoot, "openclaw.json");
  await mkdir(stateRoot);
  await writeFile(
    configPath,
    `${JSON.stringify({
      channels: { moltzap: { accounts: [{ id: "packed-agent" }] } },
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { "openclaw-channel": { enabled: true } },
      },
    })}\n`,
  );
  const env = {
    ...process.env,
    HOME: stateRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: stateRoot,
    OPENCLAW_STATE_DIR: stateRoot,
  };
  const openclaw = async (args) => {
    const { stdout } = await exec(
      process.execPath,
      [join(openclawRoot, "openclaw.mjs"), ...args, "--json"],
      { cwd: consumerRoot, env, maxBuffer: MAX_BUFFER },
    );
    return JSON.parse(stdout);
  };
  return { openclaw, pluginRoot };
}

try {
  const { archives } = await packWorkspaceClosure(
    packageRoots,
    temporaryRoot,
    new Set(Object.keys(packageRoots)),
  );
  const consumerRoot = await installPackedConsumer({
    temporaryRoot,
    workspaceRoot,
    name: "moltzap-openclaw-packed-consumer",
    archives,
    dependencies: { effect: "3.22.0", openclaw: OPENCLAW_VERSION },
    devDependencies: { typescript: "6.0.2" },
  });
  await verifyTypes(consumerRoot);

  const { openclaw, pluginRoot } = await pluginHost(consumerRoot);
  const plugin = (await openclaw(["plugins", "list"])).plugins.find(
    (candidate) => candidate.id === "openclaw-channel",
  );
  requireCondition(
    plugin?.enabled === true &&
      plugin.status === "loaded" &&
      JSON.stringify(plugin.channelIds) === JSON.stringify(["moltzap"]),
    `expected OpenClaw ${OPENCLAW_VERSION} to load the channel and register "moltzap", got ${JSON.stringify(plugin)}`,
  );

  const skill = await openclaw(["skills", "info", "group-messaging"]);
  requireCondition(
    skill.eligible === true && skill.modelVisible === true,
    `expected OpenClaw to show the group-messaging skill to the model, got ${JSON.stringify(skill)}`,
  );
  const [served, packed] = await Promise.all([
    readFile(skill.filePath, "utf8"),
    readFile(join(pluginRoot, "skills", "group-messaging", "SKILL.md"), "utf8"),
  ]);
  requireCondition(
    served === packed,
    "expected OpenClaw to serve the packed group-messaging skill text",
  );
  process.stdout.write(
    `OpenClaw ${OPENCLAW_VERSION} packed consumer check passed\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
