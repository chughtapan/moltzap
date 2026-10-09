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
import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GateError,
  type GateServices,
  installPackedConsumer,
  makeTemporaryRoot,
  PackGateError,
  packWorkspaceClosure,
  readJsonFile,
  readText,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

/** Runs one OpenClaw CLI command that prints JSON and returns the decoded output. */
type OpenClawCli = (
  args: readonly string[],
) => Effect.Effect<JsonObject, GateError, GateServices>;

type JsonObject = typeof jsonObject.Type;

const jsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const channelManifest = Schema.Struct({
  devDependencies: Schema.Struct({ openclaw: Schema.String }),
});
const openClawManifest = Schema.Struct({
  scripts: Schema.Struct({ postinstall: Schema.String }),
});
const pluginList = Schema.Struct({ plugins: Schema.Array(jsonObject) });

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const channelRoot = join(workspaceRoot, "packages", "openclaw-channel");
const packageRoots = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/openclaw-channel": channelRoot,
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
};

runGate(
  Effect.gen(function* () {
    /** The OpenClaw release the channel is built and tested against. */
    const openclawVersion = (yield* readJsonFile(
      join(channelRoot, "package.json"),
      channelManifest,
    )).devDependencies.openclaw;
    const temporaryRoot = yield* makeTemporaryRoot("moltzap-openclaw-pack-");
    const { archives } = yield* packWorkspaceClosure(
      packageRoots,
      temporaryRoot,
      new Set(Object.keys(packageRoots)),
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-openclaw-packed-consumer",
      archives,
      dependencies: { effect: "3.22.0", openclaw: openclawVersion },
      devDependencies: { typescript: "6.0.2" },
    });
    yield* verifyTypes(consumerRoot);
    const { openclaw, pluginRoot } = yield* pluginHost(consumerRoot);
    yield* verifyPluginLoaded(openclaw, openclawVersion);
    yield* verifySkillServed(openclaw, pluginRoot);
    return `OpenClaw ${openclawVersion} packed consumer check passed`;
  }),
);

/**
 * Requires that a TypeScript consumer compiles against the packed entry point.
 * @param consumerRoot Directory the packed closure is installed in.
 */
function verifyTypes(
  consumerRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
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
    yield* fs.writeFileString(
      join(consumerRoot, "check.ts"),
      'import plugin from "@moltzap/openclaw-channel";\nconst pluginId: string = plugin.id;\nvoid pluginId;\n',
    );
    yield* runCommand(
      join(consumerRoot, "node_modules", ".bin", "tsc"),
      ["--project", join(consumerRoot, "tsconfig.json")],
      { cwd: consumerRoot },
    );
  });
}

/**
 * Configure an isolated OpenClaw host that loads the channel by path, as the
 * agent image does. The consumer install skipped every lifecycle script, and
 * OpenClaw's CLI refuses to start from a package whose postinstall never ran,
 * so this runs OpenClaw's own. The pnpm install leaves package files as hard
 * links into its store, and OpenClaw silently skips a plugin whose files are
 * hard links, so the channel's files are rewritten as plain files first, as
 * an `npm` install leaves them.
 * @param consumerRoot Directory the packed closure is installed in.
 * @returns A runner for OpenClaw CLI commands that print JSON, and the
 * channel's root.
 */
function pluginHost(
  consumerRoot: string,
): Effect.Effect<
  { readonly openclaw: OpenClawCli; readonly pluginRoot: string },
  GateError,
  GateServices
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pluginRoot = yield* fs.realPath(
      join(consumerRoot, "node_modules", "@moltzap", "openclaw-channel"),
    );
    const openclawRoot = yield* fs.realPath(
      join(consumerRoot, "node_modules", "openclaw"),
    );
    yield* unlinkPluginFiles(pluginRoot);
    const { scripts } = yield* readJsonFile(
      join(openclawRoot, "package.json"),
      openClawManifest,
    );
    yield* runCommand("sh", ["-c", scripts.postinstall], { cwd: openclawRoot });
    const stateRoot = join(consumerRoot, "openclaw-state");
    const configPath = join(stateRoot, "openclaw.json");
    yield* writeHostConfig(stateRoot, configPath, pluginRoot);
    const env = {
      HOME: stateRoot,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: stateRoot,
      OPENCLAW_STATE_DIR: stateRoot,
    };
    const openclaw: OpenClawCli = (args) =>
      runCommand(
        process.execPath,
        [join(openclawRoot, "openclaw.mjs"), ...args, "--json"],
        { cwd: consumerRoot, env },
      ).pipe(
        Effect.flatMap((stdout) =>
          Schema.decodeUnknown(Schema.parseJson(jsonObject))(stdout),
        ),
      );
    return { openclaw, pluginRoot };
  });
}

/**
 * Rewrite every file under `root` as a plain file, replacing the hard link
 * pnpm installed.
 * @param root Directory to rewrite.
 */
function unlinkPluginFiles(
  root: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(root, { recursive: true });
    yield* Effect.forEach(
      entries.map((entry) => join(root, entry)),
      (file) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(file);
          if (info.type === "File") {
            const content = yield* fs.readFile(file);
            yield* fs.remove(file);
            yield* fs.writeFile(file, content);
          }
        }),
      { concurrency: 1, discard: true },
    );
  });
}

function writeHostConfig(
  stateRoot: string,
  configPath: string,
  pluginRoot: string,
): Effect.Effect<void, GateError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(stateRoot);
    yield* fs.writeFileString(
      configPath,
      `${JSON.stringify({
        channels: { moltzap: { accounts: [{ id: "packed-agent" }] } },
        plugins: {
          load: { paths: [pluginRoot] },
          entries: { "openclaw-channel": { enabled: true } },
        },
      })}\n`,
    );
  });
}

function verifyPluginLoaded(
  openclaw: OpenClawCli,
  openclawVersion: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const listed = yield* openclaw(["plugins", "list"]);
    const { plugins } = yield* Schema.decodeUnknown(pluginList)(listed);
    const plugin = plugins.find(
      (candidate) => candidate.id === "openclaw-channel",
    );
    yield* requireCondition(
      plugin?.enabled === true &&
        plugin.status === "loaded" &&
        JSON.stringify(plugin.channelIds) === JSON.stringify(["moltzap"]),
      `expected OpenClaw ${openclawVersion} to load the channel and register "moltzap", got ${JSON.stringify(plugin)}`,
    );
  });
}

function verifySkillServed(
  openclaw: OpenClawCli,
  pluginRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const skill = yield* openclaw(["skills", "info", "group-messaging"]);
    yield* requireCondition(
      skill.eligible === true && skill.modelVisible === true,
      `expected OpenClaw to show the group-messaging skill to the model, got ${JSON.stringify(skill)}`,
    );
    const servedPath = skill.filePath;
    if (typeof servedPath !== "string") {
      return yield* new PackGateError({
        message: `expected OpenClaw to name the served skill file, got ${JSON.stringify(skill)}`,
      });
    }
    const [served, packed] = yield* Effect.all(
      [
        readText(servedPath, `OpenClaw serves a missing skill ${servedPath}`),
        readText(
          join(pluginRoot, "skills", "group-messaging", "SKILL.md"),
          "packed group-messaging skill is missing",
        ),
      ],
      { concurrency: 2 },
    );
    yield* requireCondition(
      served === packed,
      "expected OpenClaw to serve the packed group-messaging skill text",
    );
  });
}
