import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileSystem, Path } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import type { PlatformError } from "@effect/platform/Error";
import { Effect, Exit, Cause } from "effect";
import { loadConfigFromFile, ConfigLoadError } from "./loader.js";

const VALID_YAML = `
database:
  url: postgres://localhost:5432/moltzap
`;

const files = new Map<string, string>();

const fileSystemError = (
  method: string,
  path: string,
  description: string,
): SystemError =>
  new SystemError({
    reason: method === "realPath" ? "PermissionDenied" : "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description,
  });

const readFileString = vi.fn(
  (path: string, _encoding?: string): Effect.Effect<string, PlatformError> => {
    const contents = files.get(path);
    if (contents === undefined) {
      return Effect.fail(
        fileSystemError(
          "readFileString",
          path,
          "ENOENT: no such file or directory",
        ),
      );
    }
    return Effect.succeed(contents);
  },
);

const realPath = vi.fn(
  (path: string): Effect.Effect<string, PlatformError> => Effect.succeed(path),
);

const testFileSystem = {
  readFileString,
  realPath,
} satisfies Pick<FileSystem.FileSystem, "readFileString" | "realPath">;

const testFileSystemService = FileSystem.makeNoop(testFileSystem);

const loadConfig = (
  path?: string,
  processEnv?: Readonly<Record<string, string | undefined>>,
) =>
  loadConfigFromFile(path, processEnv).pipe(
    Effect.provideService(FileSystem.FileSystem, testFileSystemService),
    Effect.provide(Path.layer),
  );

const setConfigFile = (path: string, contents: string): void => {
  files.set(path, contents);
};

beforeEach(() => {
  files.clear();
  readFileString.mockClear();
  realPath.mockReset();
  realPath.mockImplementation((path: string) => Effect.succeed(path));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Pull the `ConfigLoadError` out of an Exit — fails the test if the exit isn't a failure carrying our tagged error. */
function expectConfigLoadError(
  exit: Exit.Exit<unknown, ConfigLoadError>,
): ConfigLoadError {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success");
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error(`expected failure in cause, got ${exit.cause}`);
  }
  expect(failure.value).toBeInstanceOf(ConfigLoadError);
  return failure.value;
}

describe("loadConfigFromFile", () => {
  it("loads valid YAML and returns parsed config", async () => {
    setConfigFile("test.yaml", VALID_YAML);

    const config = await Effect.runPromise(loadConfig("test.yaml"));
    expect(config.database?.url).toBe("postgres://localhost:5432/moltzap");
  });

  it("interpolates ${ENV_VAR} references", async () => {
    vi.stubEnv("TEST_DB_URL", "postgres://prod:5432/db");
    setConfigFile(
      "test.yaml",
      `
database:
  url: \${TEST_DB_URL}
`,
    );

    const config = await Effect.runPromise(loadConfig("test.yaml"));
    expect(config.database?.url).toBe("postgres://prod:5432/db");
  });

  it("interpolates multiple env vars in one string", async () => {
    vi.stubEnv("DB_HOST", "myhost");
    vi.stubEnv("DB_PORT", "5433");
    setConfigFile(
      "test.yaml",
      `
database:
  url: postgres://\${DB_HOST}:\${DB_PORT}/moltzap
`,
    );

    const config = await Effect.runPromise(loadConfig("test.yaml"));
    expect(config.database?.url).toBe("postgres://myhost:5433/moltzap");
  });

  it("fails with env ConfigLoadError for missing env var", async () => {
    delete process.env["MISSING_VAR"];
    setConfigFile(
      "test.yaml",
      `
database:
  url: \${MISSING_VAR}
`,
    );

    const exit = await Effect.runPromiseExit(loadConfig("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("env");
    expect(err.message).toContain("MISSING_VAR");
  });

  it("fails with yaml ConfigLoadError for invalid YAML", async () => {
    setConfigFile("test.yaml", "{{{{not yaml");

    const exit = await Effect.runPromiseExit(loadConfig("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("yaml");
    expect(err.message).toContain("Invalid YAML");
  });

  it("fails with read ConfigLoadError for missing file", async () => {
    const exit = await Effect.runPromiseExit(loadConfig("missing.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("read");
    expect(err.message).toContain("Cannot read config file");
  });

  it("fails with validation ConfigLoadError carrying a ConfigError tree", async () => {
    setConfigFile(
      "test.yaml",
      `
server:
  port: -1
`,
    );

    const exit = await Effect.runPromiseExit(loadConfig("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("validation");
    expect(err.configError).toBeDefined();
  });

  it("defaults to MOLTZAP_CONFIG env var when no path given", async () => {
    vi.stubEnv("MOLTZAP_CONFIG", "custom.yaml");
    setConfigFile("custom.yaml", VALID_YAML);

    await Effect.runPromise(loadConfig());
    expect(readFileString).toHaveBeenCalledWith("custom.yaml", "utf-8");
  });

  it("defaults to moltzap.yaml when no path and no env var", async () => {
    delete process.env["MOLTZAP_CONFIG"];
    setConfigFile("moltzap.yaml", VALID_YAML);

    await Effect.runPromise(loadConfig());
    expect(readFileString).toHaveBeenCalledWith("moltzap.yaml", "utf-8");
  });

  it("falls back to dirname(configPath) when realpathSync throws", async () => {
    // Bug-fix coverage: when a config file lives at a path whose symlink
    // resolution fails (e.g. the file doesn't exist on disk during tests,
    // or FileSystem.realPath fails with a permission error), the loader must not
    // crash — it falls back to `dirname(configPath)` so `_configDir` is
    // still a usable string for resolving paths relative to the config.
    setConfigFile("/some/dir/moltzap.yaml", VALID_YAML);
    realPath.mockImplementation(
      (path: string): Effect.Effect<string, PlatformError> =>
        Effect.fail(
          fileSystemError("realPath", path, "EACCES: permission denied"),
        ),
    );

    const config = await Effect.runPromise(
      loadConfig("/some/dir/moltzap.yaml"),
    );
    expect(config._configDir).toBe("/some/dir");
  });

  it("fails with env ConfigLoadError when env var is set but empty", async () => {
    // `${HOST}` where HOST="" would otherwise silently interpolate an
    // empty string into URLs like "https://${HOST}/callback", passing the
    // outer `nonEmptyString` check but producing a broken URL at runtime.
    // loader.ts:41 treats empty === undefined so the operator hits the
    // error at config-load time instead of during request handling.
    vi.stubEnv("HOST", "");
    setConfigFile(
      "test.yaml",
      `
database:
  url: postgres://\${HOST}:5432/db
`,
    );

    const exit = await Effect.runPromiseExit(loadConfig("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("env");
    expect(err.message).toContain("HOST");
  });

  it("interpolates env vars inside arrays", async () => {
    vi.stubEnv("ORIGIN", "https://app.example.com");
    setConfigFile(
      "test.yaml",
      `
database:
  url: pg://localhost/db
server:
  cors_origins:
    - \${ORIGIN}
`,
    );

    const config = await Effect.runPromise(loadConfig("test.yaml"));
    expect(config.server?.cors_origins).toEqual(["https://app.example.com"]);
  });

  // Top-level YAML trust boundary: previously an unchecked `as unknown` cast
  // on `parseYaml`. A scalar / array / null top level used to make every
  // subsequent `Config.nested(...)` silently report a missing key. The
  // schema at the boundary now rejects these cases with a clear message.
  it.each([
    ["scalar string", "hello"],
    ["array", "- 1\n- 2\n"],
    ["null", "~"],
  ])("rejects non-mapping YAML top-level (%s)", async (_label, yaml) => {
    setConfigFile("test.yaml", yaml);

    const exit = await Effect.runPromiseExit(loadConfig("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("yaml");
    expect(err.message).toMatch(/top-level value must be a mapping/);
  });
});
