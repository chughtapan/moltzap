/**
 * @file Proves the packed `@moltzap/nanoclaw-channel` exposes exactly its root
 * entry point, compiles against the packed Client closure for a strict
 * TypeScript consumer, and imports from an isolated consumer without
 * exporting anything.
 */
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Archives,
  extractPackedArchive,
  type GateError,
  type GateServices,
  installPackedConsumer,
  type PackedManifest,
  PackGateError,
  packWorkspaceClosure,
  readText,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoots = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/nanoclaw-channel": join(
    workspaceRoot,
    "packages",
    "nanoclaw-channel",
  ),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
};
const ROOT_EXPORT = {
  types: "./dist/channels/moltzap.d.ts",
  import: "./dist/channels/moltzap.js",
};
const CONSUMER_TSCONFIG = {
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
};
const CONSUMER_CHECK_TS = [
  "// The package registers its channel with NanoClaw's registry on import",
  "// and exports nothing. A side-effect import still loads its declarations,",
  "// so this compile checks them and the Client and Effect types they reach",
  "// from inside the packed closure.",
  'import "@moltzap/nanoclaw-channel";',
  "",
].join("\n");
const CONSUMER_CHECK_MJS = [
  'const channel = await import("@moltzap/nanoclaw-channel");',
  "const exported = Object.keys(channel);",
  "if (exported.length !== 0) {",
  '  throw new Error(`NanoClaw channel must export nothing: ${exported.join(",")}`);',
  "}",
  "",
].join("\n");

/** The adapter itself is private; its Client closure publishes. */
const publishedPackages: ReadonlySet<string> = new Set(
  Object.keys(packageRoots).filter(
    (name) => name !== "@moltzap/nanoclaw-channel",
  ),
);

runGate("moltzap-nanoclaw-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives, manifests } = yield* packWorkspaceClosure(
      packageRoots,
      temporaryRoot,
      publishedPackages,
    );
    const archive = archives["@moltzap/nanoclaw-channel"];
    const manifest = manifests["@moltzap/nanoclaw-channel"];
    if (archive === undefined || manifest === undefined) {
      return yield* new PackGateError({ message: "NanoClaw did not pack" });
    }
    yield* verifyPackedManifest(archive, manifest, temporaryRoot);
    yield* verifyConsumer(archives, temporaryRoot);
    return "NanoClaw packed consumer check passed";
  }),
);

function verifyPackedManifest(
  archive: string,
  manifest: PackedManifest,
  temporaryRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const extractedPackage = yield* extractPackedArchive(
      archive,
      temporaryRoot,
    );
    yield* requireCondition(
      manifest.main === ROOT_EXPORT.import &&
        manifest.types === ROOT_EXPORT.types,
      "packed NanoClaw main and types must match its root export",
    );
    yield* requireCondition(
      JSON.stringify(manifest.exports) === JSON.stringify({ ".": ROOT_EXPORT }),
      "packed NanoClaw package must expose exactly its root entrypoint",
    );
    yield* Effect.forEach(
      [ROOT_EXPORT.import, ROOT_EXPORT.types],
      (path) =>
        readText(
          join(extractedPackage, path),
          `packed NanoClaw package is missing ${path}`,
        ),
      { concurrency: 2, discard: true },
    );
  });
}

function verifyConsumer(
  archives: Archives,
  temporaryRoot: string,
): Effect.Effect<void, GateError, GateServices> {
  return Effect.gen(function* () {
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-nanoclaw-packed-consumer",
      archives,
      dependencies: { effect: "3.22.0" },
      devDependencies: { typescript: "6.0.2" },
    });
    const fs = yield* FileSystem.FileSystem;
    const checkPath = join(consumerRoot, "check.mjs");
    yield* fs.writeFileString(
      join(consumerRoot, "tsconfig.json"),
      `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`,
    );
    yield* fs.writeFileString(
      join(consumerRoot, "check.ts"),
      CONSUMER_CHECK_TS,
    );
    yield* fs.writeFileString(checkPath, CONSUMER_CHECK_MJS);
    yield* runCommand(
      join(consumerRoot, "node_modules", ".bin", "tsc"),
      ["--project", join(consumerRoot, "tsconfig.json")],
      { cwd: consumerRoot },
    );
    yield* runCommand(process.execPath, [checkPath], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
  });
}
