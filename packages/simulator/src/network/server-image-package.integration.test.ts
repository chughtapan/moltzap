/**
 * @file Installed-package smoke for the MoltZap router image builder.
 * The test extracts real package tarballs into a consumer-shaped node_modules
 * tree with no workspace and verifies the packaged builder stages its exact
 * server, protocol, Dockerfile, and configuration inputs.
 *
 * Gate: `MOLTZAP_SIM_ITEST=1`.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertions run inside a scoped Effect so every temporary package tree is released */
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { delimiter, dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SIM_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_SIM_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workspaceRoot = dirname(dirname(packageRoot));
const packageRoots = {
  protocol: join(workspaceRoot, "packages", "protocol"),
  server: join(workspaceRoot, "packages", "server"),
  simulator: packageRoot,
} as const;
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const SERVER_PROTOCOL_FIXTURE_VERSION = "0.0.0-server-protocol";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function packedFilename(output: string): string {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("filename" in parsed) ||
    typeof parsed.filename !== "string"
  ) {
    throw new Error("pnpm pack returned no tarball filename");
  }
  return parsed.filename;
}

function packPackage(packageDirectory: string, destination: string) {
  return Command.make(
    "pnpm",
    "pack",
    "--pack-destination",
    destination,
    "--json",
  ).pipe(
    Command.workingDirectory(packageDirectory),
    Command.string,
    Effect.map(packedFilename),
  );
}

function extractPackage(archive: string, destination: string) {
  return Command.make(
    "tar",
    "-xzf",
    archive,
    "--strip-components=1",
    "-C",
    destination,
  ).pipe(
    Command.exitCode,
    Effect.filterOrFail((code) => Number(code) === 0),
    Effect.asVoid,
  );
}

function fakeDockerCompletion(markerPath: string): string {
  return `writeFileSync(
  ${JSON.stringify(markerPath)},
  JSON.stringify({
    protocol: specifications[1],
    tarballs: specifications.length,
  }),
);`;
}

function fakeDockerSource(markerPath: string): string {
  return `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "image" && args[1] === "inspect") {
  if (args.includes("--format")) {
    process.stdout.write(${JSON.stringify(IMAGE_DIGEST)} + "\\n");
    process.exit(0);
  }
  process.exit(1);
}

if (args[0] !== "build") {
  throw new Error("unexpected docker command: " + args.join(" "));
}

const context = args.at(-1);
if (context === undefined) throw new Error("docker build has no context");
for (const asset of ["Dockerfile", "moltzap.yaml", "package.json"]) {
  if (!existsSync(join(context, asset))) {
    throw new Error("missing staged asset " + asset);
  }
}
const manifestText = readFileSync(join(context, "package.json"), "utf8");
if (manifestText.includes("workspace:")) {
  throw new Error("staged manifest contains a workspace dependency");
}
const manifest = JSON.parse(manifestText);
const specifications = [
  manifest.dependencies?.["@moltzap/server-core"],
  manifest.overrides?.["@moltzap/protocol"],
];
for (const specification of specifications) {
  if (
    typeof specification !== "string" ||
    !specification.startsWith("file:./tarballs/")
  ) {
    throw new Error("staged dependency is not a package tarball");
  }
  if (!existsSync(join(context, specification.slice("file:./".length)))) {
    throw new Error("staged dependency tarball is missing");
  }
}
${fakeDockerCompletion(markerPath)}
`;
}

function installServerProtocolFixture(
  fileSystem: FileSystem.FileSystem,
  archive: string,
  serverDirectory: string,
) {
  return Effect.gen(function* () {
    const destination = join(
      serverDirectory,
      "node_modules",
      "@moltzap",
      "protocol",
    );
    yield* fileSystem.makeDirectory(destination, { recursive: true });
    yield* extractPackage(archive, destination);
    const manifestPath = join(destination, "package.json");
    const manifest: unknown = JSON.parse(
      yield* fileSystem.readFileString(manifestPath, "utf8"),
    );
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      return yield* Effect.dieMessage(
        "packed protocol manifest is not an object",
      );
    }
    yield* fileSystem.writeFileString(
      manifestPath,
      JSON.stringify({
        ...manifest,
        version: SERVER_PROTOCOL_FIXTURE_VERSION,
      }),
    );
  });
}

function prepareInstalledLayout(
  fileSystem: FileSystem.FileSystem,
  root: string,
) {
  return Effect.gen(function* () {
    const tarballs = join(root, "tarballs");
    const consumer = join(root, "consumer");
    const scopeDirectory = join(consumer, "node_modules", "@moltzap");
    const fakeBin = join(root, "bin");
    const marker = join(root, "docker-context.json");
    yield* fileSystem.makeDirectory(tarballs, { recursive: true });
    yield* fileSystem.makeDirectory(scopeDirectory, { recursive: true });
    yield* fileSystem.makeDirectory(fakeBin, { recursive: true });
    const archives = yield* Effect.all(
      {
        protocol: packPackage(packageRoots.protocol, tarballs),
        "server-core": packPackage(packageRoots.server, tarballs),
        simulator: packPackage(packageRoots.simulator, tarballs),
      },
      { concurrency: 3 },
    );
    for (const [name, archive] of Object.entries(archives)) {
      const destination = join(scopeDirectory, name);
      yield* fileSystem.makeDirectory(destination, { recursive: true });
      yield* extractPackage(archive, destination);
    }
    yield* installServerProtocolFixture(
      fileSystem,
      archives.protocol,
      join(scopeDirectory, "server-core"),
    );
    const fakeDocker = join(fakeBin, "docker");
    yield* fileSystem.writeFileString(fakeDocker, fakeDockerSource(marker));
    // eslint-disable-next-line sonarjs/file-permissions -- this temporary fixture must be executable to stand in for the docker command
    yield* fileSystem.chmod(fakeDocker, 0o755);
    return { consumer, fakeBin, marker, scopeDirectory } as const;
  });
}

function runInstalledBuilder(
  input: Effect.Effect.Success<ReturnType<typeof prepareInstalledLayout>>,
  operatorPath: string,
) {
  const builder = join(
    input.scopeDirectory,
    "simulator",
    "scripts",
    "build-server-image.mjs",
  );
  return Command.make(execPath, builder).pipe(
    Command.workingDirectory(input.consumer),
    Command.env({ PATH: `${input.fakeBin}${delimiter}${operatorPath}` }),
    Command.string,
  );
}

const installedPackageSmoke = Effect.scoped(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const operatorPath = yield* Config.string("PATH");
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-installed-server-image-",
    });
    const layout = yield* prepareInstalledLayout(fileSystem, root);
    const output = yield* runInstalledBuilder(layout, operatorPath);
    const completionLine = output.trim().split("\n").at(-1);
    if (completionLine === undefined) {
      return yield* Effect.dieMessage("image builder returned no completion");
    }
    const completionInput: unknown = JSON.parse(completionLine);
    const completion = requireRecord(
      completionInput,
      "image builder completion",
    );
    expect(completion.imageDigest).toBe(IMAGE_DIGEST);
    if (typeof completion.serverCoreVersion !== "string") {
      return yield* Effect.dieMessage(
        "image builder server version must be text",
      );
    }
    const stagedInput: unknown = JSON.parse(
      yield* fileSystem.readFileString(layout.marker, "utf8"),
    );
    const staged = requireRecord(stagedInput, "staged image marker");
    expect(staged.tarballs).toBe(2);
    if (typeof staged.protocol !== "string") {
      return yield* Effect.dieMessage("staged protocol marker must be text");
    }
    expect(staged.protocol).toContain(SERVER_PROTOCOL_FIXTURE_VERSION);
  }),
).pipe(Effect.provide(NodeContext.layer), Effect.orDie);

describe.skipIf(!SIM_INTEGRATION_ENABLED)(
  "installed MoltZap router image builder",
  () => {
    it("stages every image input from package tarballs", () =>
      Effect.runPromise(installedPackageSmoke));
  },
);

/* eslint-enable sonarjs/assertions-in-tests -- Restore strict defaults after the scoped file-level exception. */
