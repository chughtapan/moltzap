import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Exit, Cause } from "effect";
import { loadConfigFromFile, ConfigLoadError } from "./loader.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

import { readFileSync, realpathSync } from "node:fs";

const VALID_YAML = `
database:
  url: postgres://localhost:5432/moltzap
`;

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
  // Default: realpathSync is an identity function (as declared in the
  // top-level mock). Per-test overrides can replace this behavior.
  vi.mocked(realpathSync).mockReset();
  vi.mocked(realpathSync).mockImplementation(((p: string) => p) as never);
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
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    const config = await Effect.runPromise(loadConfigFromFile("test.yaml"));
    expect(config.database?.url).toBe("postgres://localhost:5432/moltzap");
  });

  it("interpolates ${ENV_VAR} references", async () => {
    vi.stubEnv("TEST_DB_URL", "postgres://prod:5432/db");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: \${TEST_DB_URL}
`);

    const config = await Effect.runPromise(loadConfigFromFile("test.yaml"));
    expect(config.database?.url).toBe("postgres://prod:5432/db");
  });

  it("interpolates multiple env vars in one string", async () => {
    vi.stubEnv("DB_HOST", "myhost");
    vi.stubEnv("DB_PORT", "5433");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: postgres://\${DB_HOST}:\${DB_PORT}/moltzap
`);

    const config = await Effect.runPromise(loadConfigFromFile("test.yaml"));
    expect(config.database?.url).toBe("postgres://myhost:5433/moltzap");
  });

  it("fails with env ConfigLoadError for missing env var", async () => {
    delete process.env["MISSING_VAR"];
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: \${MISSING_VAR}
`);

    const exit = await Effect.runPromiseExit(loadConfigFromFile("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("env");
    expect(err.message).toContain("MISSING_VAR");
  });

  it("fails with yaml ConfigLoadError for invalid YAML", async () => {
    vi.mocked(readFileSync).mockReturnValue("{{{{not yaml");

    const exit = await Effect.runPromiseExit(loadConfigFromFile("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("yaml");
    expect(err.message).toContain("Invalid YAML");
  });

  it("fails with read ConfigLoadError for missing file", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const exit = await Effect.runPromiseExit(
      loadConfigFromFile("missing.yaml"),
    );
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("read");
    expect(err.message).toContain("Cannot read config file");
  });

  it("fails with validation ConfigLoadError carrying a ConfigError tree", async () => {
    vi.mocked(readFileSync).mockReturnValue(`
server:
  port: -1
`);

    const exit = await Effect.runPromiseExit(loadConfigFromFile("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("validation");
    expect(err.configError).toBeDefined();
  });

  it("defaults to MOLTZAP_CONFIG env var when no path given", async () => {
    vi.stubEnv("MOLTZAP_CONFIG", "custom.yaml");
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    await Effect.runPromise(loadConfigFromFile());
    expect(readFileSync).toHaveBeenCalledWith("custom.yaml", "utf-8");
  });

  it("defaults to moltzap.yaml when no path and no env var", async () => {
    delete process.env["MOLTZAP_CONFIG"];
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    await Effect.runPromise(loadConfigFromFile());
    expect(readFileSync).toHaveBeenCalledWith("moltzap.yaml", "utf-8");
  });

  it("falls back to dirname(configPath) when realpathSync throws", async () => {
    // Bug-fix coverage: when a config file lives at a path whose symlink
    // resolution fails (e.g. the file doesn't exist on disk during tests,
    // or fs.realpathSync throws a permission error), the loader must not
    // crash — it falls back to `dirname(configPath)` so `_configDir` is
    // still a usable string for resolving paths relative to the config.
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);
    vi.mocked(realpathSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    // Swallow the single console.warn the loader emits so the suite
    // output stays clean — we still assert the fallback behavior below.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = await Effect.runPromise(
      loadConfigFromFile("/some/dir/moltzap.yaml"),
    );
    expect(config._configDir).toBe("/some/dir");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("fails with env ConfigLoadError when env var is set but empty", async () => {
    // `${HOST}` where HOST="" would otherwise silently interpolate an
    // empty string into URLs like "https://${HOST}/callback", passing the
    // outer `nonEmptyString` check but producing a broken URL at runtime.
    // loader.ts:41 treats empty === undefined so the operator hits the
    // error at config-load time instead of during request handling.
    vi.stubEnv("HOST", "");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: postgres://\${HOST}:5432/db
`);

    const exit = await Effect.runPromiseExit(loadConfigFromFile("test.yaml"));
    const err = expectConfigLoadError(exit);
    expect(err.kind).toBe("env");
    expect(err.message).toContain("HOST");
  });

  it("interpolates env vars inside arrays", async () => {
    vi.stubEnv("ORIGIN", "https://app.example.com");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: pg://localhost/db
server:
  cors_origins:
    - \${ORIGIN}
`);

    const config = await Effect.runPromise(loadConfigFromFile("test.yaml"));
    expect(config.server?.cors_origins).toEqual(["https://app.example.com"]);
  });
});
