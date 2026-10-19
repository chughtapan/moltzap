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
import { FINAL_PACKAGES } from "./architecture/boundary-contract.ts";
import {
  type Archives,
  checkConsumerTypes,
  extractPackedArchive,
  type GateError,
  type GateServices,
  installPackedConsumer,
  type PackedManifest,
  PackGateError,
  packProductClosure,
  readConsumerPins,
  readText,
  requireCondition,
  runCommand,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ROOT_EXPORT = FINAL_PACKAGES["nanoclaw-channel"].exports["."];
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

runGate("moltzap-nanoclaw-pack-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives, manifests } = yield* packProductClosure(
      workspaceRoot,
      "nanoclaw-channel",
      temporaryRoot,
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
    if (ROOT_EXPORT === undefined) {
      return yield* new PackGateError({
        message: "NanoClaw root export is missing",
      });
    }
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
      JSON.stringify(manifest.exports) ===
        JSON.stringify(FINAL_PACKAGES["nanoclaw-channel"].exports),
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
    const pins = yield* readConsumerPins(workspaceRoot);
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "moltzap-nanoclaw-packed-consumer",
      archives,
      dependencies: { effect: pins.effect },
      devDependencies: { typescript: pins.typescript },
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
    yield* checkConsumerTypes(consumerRoot);
    yield* runCommand(process.execPath, [checkPath], {
      cwd: consumerRoot,
      env: { NODE_PATH: "" },
    });
  });
}
