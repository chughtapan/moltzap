/**
 * @file Produces private remote receiver assets from the same Client release,
 * without publishing a new npm product or packaging an owner's configuration.
 */
import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  type GateError,
  type GateServices,
  readJsonFile,
  requireCondition,
  runCommand,
} from "./test/packed-workspace.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const runtimeFiles = [
  "bin/receive.mjs",
  "dist/run.js",
  "dist/native/index.js",
  "dist/instinct/index.js",
  "dist/grokbot/index.js",
  "README.md",
  "bin/install-prompt.mjs",
  "bin/install.mjs",
  "dist/install/command.js",
  "dist/install/model.js",
  "dist/install/protocol.js",
  "dist/install/receipt.js",
  "dist/muse/index.js",
  "dist/muse/work.js",
  "dist/muse/worker.js",
  "dist/muse/command.js",
  "install.md",
  "muse/README.md",
  "muse/hook.sh",
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

const sourceManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Unknown),
  version: Schema.optional(Schema.Unknown),
  exports: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
});
type SourceManifest = typeof sourceManifest.Type;
const clientManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});
const workspaceManifest = Schema.Struct({ packageManager: Schema.String });

/** The byte digest binds the private archive and its filename-specific sidecar. */
export interface NativeArchive {
  readonly archive: string;
  readonly sha256: string;
}

/**
 * Packs explicit regular-file inputs with exact dependency versions. The
 * trusted checkout must stay stable during copying; the input checks reject
 * symlinked leaf and ancestor paths but do not isolate a concurrent writer.
 * @param root Source workspace with native assets already built.
 * @param destination Owned archive output, separate from cached compiled assets.
 * @returns Archive path and digest; staging is removed on every exit.
 */
export function packageNativePlugins(
  root: string,
  destination?: string,
): Effect.Effect<NativeArchive, GateError, GateServices> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const [native, client, workspace, nodeVersion] = yield* Effect.all(
        [
          readJsonFile(join(root, "plugins/package.json"), sourceManifest),
          readJsonFile(
            join(root, "packages/client/package.json"),
            clientManifest,
          ),
          readJsonFile(join(root, "package.json"), workspaceManifest),
          fs.readFileString(join(root, ".node-version")),
        ],
        { concurrency: 4 },
      );
      const manifest = yield* receiverManifest(
        native,
        client,
        workspace.packageManager,
        nodeVersion.trim(),
      );
      const staging = yield* fs.makeTempDirectoryScoped({
        prefix: "moltzap-native-package-",
      });
      yield* copyRuntimeFiles(root, staging);
      yield* fs.writeFileString(
        join(staging, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      return yield* packStaging(
        staging,
        resolve(destination ?? join(root, "dist/artifacts/native-plugins")),
        manifest.version,
      );
    }),
  ).pipe(Effect.withSpan("nativePlugins.package"));
}

function packStaging(staging: string, output: string, version: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(output, { recursive: true });
    yield* runCommand("pnpm", ["pack", "--pack-destination", output], {
      cwd: staging,
    });
    const archive = join(output, `moltzap-native-plugins-${version}.tgz`);
    const bytes = yield* fs.readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    yield* fs.writeFileString(
      `${archive}.sha256`,
      `${sha256}  ${basename(archive)}\n`,
    );
    return { archive, sha256 };
  });
}

/** Source metadata establishes the private same-Client-version artifact contract. */
function receiverManifest(
  native: SourceManifest,
  client: typeof clientManifest.Type,
  packageManager: string,
  nodeVersion: string,
) {
  return Effect.gen(function* () {
    yield* requireCondition(
      native.name === "@moltzap/native-plugins" &&
        native.private === true &&
        native.version === undefined &&
        native.exports === undefined,
      "native build project must stay private without publication or SDK metadata",
    );
    yield* requireCondition(
      client.name === "@moltzap/client" &&
        /^\d{4}\.\d{3,4}\.\d+$/u.test(client.version),
      "native archive requires the exact Client calendar release",
    );
    yield* requireCondition(
      /^\d+\.\d+\.\d+$/u.test(nodeVersion),
      "native archive requires the pinned Node runtime",
    );
    yield* requireCondition(
      native.dependencies !== undefined,
      "native build project dependencies are missing",
    );
    const dependencies = yield* receiverDependencies(native, client.version);
    return {
      name: native.name,
      version: client.version,
      private: true,
      type: "module",
      description:
        "Remote native receive assets; not an npm product or adapter SDK",
      license: "Apache-2.0",
      packageManager,
      engines: { node: `>=${nodeVersion}` },
      files: [...runtimeFiles, "LICENSE", "NOTICE"],
      dependencies,
    };
  });
}

function receiverDependencies(native: SourceManifest, clientVersion: string) {
  return Effect.gen(function* () {
    const dependencies = {
      ...native.dependencies,
      "@moltzap/client": clientVersion,
    };
    yield* Effect.forEach(
      Object.values(dependencies),
      (version) =>
        requireCondition(
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version),
          "native archive dependencies must be exact registry versions",
        ),
      { concurrency: 1, discard: true },
    );
    return dependencies;
  });
}

/** Exact physical paths keep both symlinked files and ancestors outside the archive. */
function copyRuntimeFiles(root: string, staging: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const physicalRoot = yield* fs.realPath(root);
    const files = [
      ...runtimeFiles.map((target) => ({
        source: join(physicalRoot, "plugins", target),
        target,
      })),
      ...["LICENSE", "NOTICE"].map((target) => ({
        source: join(physicalRoot, target),
        target,
      })),
    ];
    yield* Effect.forEach(
      files,
      ({ source, target }) =>
        Effect.gen(function* () {
          yield* requireCondition(
            (yield* fs.realPath(source)) === source,
            "native archive input cannot traverse a symlink",
          );
          yield* requireCondition(
            (yield* fs.stat(source)).type === "File",
            "native archive input must be a regular file",
          );
          yield* fs.makeDirectory(dirname(join(staging, target)), {
            recursive: true,
          });
          yield* fs.copyFile(source, join(staging, target));
        }),
      { concurrency: 1, discard: true },
    );
  });
}

if (import.meta.main) {
  NodeRuntime.runMain(
    packageNativePlugins(workspaceRoot).pipe(
      Effect.flatMap((result) =>
        Effect.sync(() => {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }),
      ),
      Effect.provide(NodeContext.layer),
    ),
  );
}
