import { it as effectIt } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect } from "vitest";

const it = effectIt.effect;

const PACKAGE_JSON_FILE = "package.json";
const BIN_FILE = "bin/moltzap-server";
const CORE_SCHEMA_FILE = "src/app/core-schema.sql";
const SERVER_BIN_NAME = "moltzap-server";
const SERVER_BIN_PATH = "bin/moltzap-server";
const UTF8_ENCODING = "utf8";
const EXECUTE_MODE_BITS = 0o111;

interface PackageJsonShape {
  readonly bin?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly files?: string[];
}

describe("@moltzap/server-core package metadata", () => {
  it("publishes a single executable bin for npx invocation", () =>
    Effect.gen(function* () {
      const paths = yield* packagePaths();
      const packageJson = yield* readPackageJson(paths.packageJsonPath);

      expect(packageJson.files).toContain("bin");
      expect(packageJson.files).toContain(CORE_SCHEMA_FILE);
      expect(packageJson.bin).toEqual({ [SERVER_BIN_NAME]: SERVER_BIN_PATH });

      yield* expectReadable(paths.coreSchemaPath);
      yield* expectExecutable(paths.binPath);
    }).pipe(Effect.provide(NodeContext.layer)));
});

function packagePaths() {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const packageRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    return {
      packageJsonPath: path.join(packageRoot, PACKAGE_JSON_FILE),
      binPath: path.join(packageRoot, BIN_FILE),
      coreSchemaPath: path.join(packageRoot, CORE_SCHEMA_FILE),
    };
  });
}

function readPackageJson(
  packageJsonPath: string,
): Effect.Effect<PackageJsonShape, unknown, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(packageJsonPath, UTF8_ENCODING)),
    Effect.map((raw) => JSON.parse(raw) as PackageJsonShape),
  );
}

function expectReadable(
  path: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.access(path, { readable: true })),
  );
}

function expectExecutable(
  path: string,
): Effect.Effect<void, unknown, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.stat(path)),
    Effect.map((info) => {
      expect(info.mode & EXECUTE_MODE_BITS).not.toBe(0);
    }),
  );
}
