import { it as effectIt } from "@effect/vitest";
import { beforeEach, describe, expect, vi } from "vitest";
import { FileSystem, Path } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import type { PlatformError } from "@effect/platform/Error";
import { Cause, Effect, Exit, Option } from "effect";
import { ConfigLoadError, loadConfigFromFile } from "./loader.js";

const it = effectIt.effect;

const TEST_CONFIG_PATH = "test.yaml";
const MISSING_CONFIG_PATH = "missing.yaml";
const CUSTOM_CONFIG_PATH = "custom.yaml";
const DEFAULT_CONFIG_PATH = "moltzap.yaml";
const NESTED_CONFIG_PATH = "/some/dir/moltzap.yaml";
const NESTED_CONFIG_DIR = "/some/dir";
const UTF8_ENCODING = "utf-8";
const LOCAL_DATABASE_URL = "postgres://localhost:5432/moltzap";
const PROD_DATABASE_URL = "postgres://prod:5432/db";
const INTERPOLATED_DATABASE_URL = "postgres://myhost:5433/moltzap";
const APP_ORIGIN = "https://app.example.com";
const TEST_DB_URL_KEY = "TEST_DB_URL";
const DB_HOST_KEY = "DB_HOST";
const DB_PORT_KEY = "DB_PORT";
const MISSING_VAR_KEY = "MISSING_VAR";
const CONFIG_PATH_ENV_KEY = "MOLTZAP_CONFIG";
const HOST_KEY = "HOST";
const ORIGIN_KEY = "ORIGIN";
const ENV_ERROR_KIND = "env";
const YAML_ERROR_KIND = "yaml";
const READ_ERROR_KIND = "read";
const VALIDATION_ERROR_KIND = "validation";
const INVALID_YAML_TEXT = "Invalid YAML";
const READ_ERROR_TEXT = "Cannot read config file";
const REAL_PATH_METHOD = "realPath";
const READ_FILE_METHOD = "readFileString";
const EACCES_DESCRIPTION = "EACCES: permission denied";
const ENOENT_DESCRIPTION = "ENOENT: no such file or directory";
const TOP_LEVEL_MAPPING_RE = /top-level value must be a mapping/;

const VALID_YAML = `
database:
  url: ${LOCAL_DATABASE_URL}
`;

const files = new Map<string, string>();

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

const fileSystemError = (
  method: string,
  path: string,
  description: string,
): SystemError =>
  new SystemError({
    reason: method === REAL_PATH_METHOD ? "PermissionDenied" : "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description,
  });

const readFileString = vi.fn(
  (path: string, _encoding?: string): Effect.Effect<string, PlatformError> => {
    const contents = files.get(path);
    if (contents !== undefined) return Effect.succeed(contents);
    return Effect.fail(
      fileSystemError(READ_FILE_METHOD, path, ENOENT_DESCRIPTION),
    );
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
const EMPTY_ENV: EnvSnapshot = {};

const loadConfig = (path: string, processEnv: EnvSnapshot = EMPTY_ENV) =>
  loadConfigFromFile(path, processEnv).pipe(
    Effect.provideService(FileSystem.FileSystem, testFileSystemService),
    Effect.provide(Path.layer),
  );

const loadDefaultConfig = (processEnv: EnvSnapshot = EMPTY_ENV) =>
  loadConfigFromFile(undefined, processEnv).pipe(
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

describe("loadConfigFromFile success cases", () => {
  it("loads valid YAML and returns parsed config", () => loadsValidYaml());

  it("interpolates env var references", () => interpolatesEnvVar());

  it("interpolates multiple env vars in one string", () =>
    interpolatesMultipleEnvVars());
});

describe("loadConfigFromFile failure classification", () => {
  it("fails with env ConfigLoadError for missing env var", () =>
    failsForMissingEnvVar());

  it("fails with yaml ConfigLoadError for invalid YAML", () =>
    failsForInvalidYaml());

  it("fails with read ConfigLoadError for missing file", () =>
    failsForMissingFile());
});

describe("loadConfigFromFile defaults and validation", () => {
  it("fails with validation ConfigLoadError carrying a ConfigError tree", () =>
    failsWithValidationError());

  it("defaults to MOLTZAP_CONFIG env var when no path given", () =>
    defaultsToEnvConfigPath());

  it("defaults to moltzap.yaml when no path and no env var", () =>
    defaultsToMoltZapYaml());
});

describe("loadConfigFromFile path resolution", () => {
  it("falls back to dirname(configPath) when realpathSync throws", () =>
    fallsBackToDirname());
});

describe("loadConfigFromFile env interpolation edges", () => {
  it("fails with env ConfigLoadError when env var is set but empty", () =>
    failsForEmptyEnvVar());

  it("interpolates env vars inside arrays", () => interpolatesArrayEnvVars());
});

describe("loadConfigFromFile YAML trust boundary", () => {
  it("rejects scalar YAML top-level", () => rejectsNonMappingYaml("hello"));

  it("rejects array YAML top-level", () => rejectsNonMappingYaml("- 1\n- 2\n"));

  it("rejects null YAML top-level", () => rejectsNonMappingYaml("~"));
});

function loadsValidYaml() {
  setConfigFile(TEST_CONFIG_PATH, VALID_YAML);
  return Effect.gen(function* () {
    const config = yield* loadConfig(TEST_CONFIG_PATH);
    expect(config.database?.url).toBe(LOCAL_DATABASE_URL);
  });
}

function interpolatesEnvVar() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
database:
  url: \${${TEST_DB_URL_KEY}}
`,
  );
  return Effect.gen(function* () {
    const config = yield* loadConfig(TEST_CONFIG_PATH, {
      [TEST_DB_URL_KEY]: PROD_DATABASE_URL,
    });
    expect(config.database?.url).toBe(PROD_DATABASE_URL);
  });
}

function interpolatesMultipleEnvVars() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
database:
  url: postgres://\${${DB_HOST_KEY}}:\${${DB_PORT_KEY}}/moltzap
`,
  );
  return Effect.gen(function* () {
    const config = yield* loadConfig(TEST_CONFIG_PATH, {
      [DB_HOST_KEY]: "myhost",
      [DB_PORT_KEY]: "5433",
    });
    expect(config.database?.url).toBe(INTERPOLATED_DATABASE_URL);
  });
}

function failsForMissingEnvVar() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
database:
  url: \${${MISSING_VAR_KEY}}
`,
  );
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(TEST_CONFIG_PATH, {})),
    );
    expect(err.kind).toBe(ENV_ERROR_KIND);
    expect(err.message).toContain(MISSING_VAR_KEY);
  });
}

function failsForInvalidYaml() {
  setConfigFile(TEST_CONFIG_PATH, "{{{{not yaml");
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(TEST_CONFIG_PATH)),
    );
    expect(err.kind).toBe(YAML_ERROR_KIND);
    expect(err.message).toContain(INVALID_YAML_TEXT);
  });
}

function failsForMissingFile() {
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(MISSING_CONFIG_PATH)),
    );
    expect(err.kind).toBe(READ_ERROR_KIND);
    expect(err.message).toContain(READ_ERROR_TEXT);
  });
}

function failsWithValidationError() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
server:
  port: -1
`,
  );
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(TEST_CONFIG_PATH)),
    );
    expect(err.kind).toBe(VALIDATION_ERROR_KIND);
    expect(err.configError).toBeDefined();
  });
}

function defaultsToEnvConfigPath() {
  setConfigFile(CUSTOM_CONFIG_PATH, VALID_YAML);
  return Effect.gen(function* () {
    yield* loadDefaultConfig({ [CONFIG_PATH_ENV_KEY]: CUSTOM_CONFIG_PATH });
    expect(readFileString).toHaveBeenCalledWith(
      CUSTOM_CONFIG_PATH,
      UTF8_ENCODING,
    );
  });
}

function defaultsToMoltZapYaml() {
  setConfigFile(DEFAULT_CONFIG_PATH, VALID_YAML);
  return Effect.gen(function* () {
    yield* loadDefaultConfig({});
    expect(readFileString).toHaveBeenCalledWith(
      DEFAULT_CONFIG_PATH,
      UTF8_ENCODING,
    );
  });
}

function fallsBackToDirname() {
  setConfigFile(NESTED_CONFIG_PATH, VALID_YAML);
  realPath.mockImplementation(
    (path: string): Effect.Effect<string, PlatformError> =>
      Effect.fail(fileSystemError(REAL_PATH_METHOD, path, EACCES_DESCRIPTION)),
  );

  return Effect.gen(function* () {
    const config = yield* loadConfig(NESTED_CONFIG_PATH);
    expect(config._configDir).toBe(NESTED_CONFIG_DIR);
  });
}

function failsForEmptyEnvVar() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
database:
  url: postgres://\${${HOST_KEY}}:5432/db
`,
  );
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(TEST_CONFIG_PATH, { [HOST_KEY]: "" })),
    );
    expect(err.kind).toBe(ENV_ERROR_KIND);
    expect(err.message).toContain(HOST_KEY);
  });
}

function interpolatesArrayEnvVars() {
  setConfigFile(
    TEST_CONFIG_PATH,
    `
database:
  url: pg://localhost/db
server:
  cors_origins:
    - \${${ORIGIN_KEY}}
`,
  );
  return Effect.gen(function* () {
    const config = yield* loadConfig(TEST_CONFIG_PATH, {
      [ORIGIN_KEY]: APP_ORIGIN,
    });
    expect(config.server?.cors_origins).toEqual([APP_ORIGIN]);
  });
}

function rejectsNonMappingYaml(yaml: string) {
  setConfigFile(TEST_CONFIG_PATH, yaml);
  return Effect.gen(function* () {
    const err = expectConfigLoadError(
      yield* Effect.exit(loadConfig(TEST_CONFIG_PATH)),
    );
    expect(err.kind).toBe(YAML_ERROR_KIND);
    expect(err.message).toMatch(TOP_LEVEL_MAPPING_RE);
  });
}

function expectConfigLoadError(
  exit: Exit.Exit<unknown, ConfigLoadError>,
): ConfigLoadError {
  if (!Exit.isFailure(exit)) expect.fail("expected failure, got success");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    expect.fail(`expected failure in cause, got ${exit.cause}`);
  }
  expect(failure.value).toBeInstanceOf(ConfigLoadError);
  return failure.value;
}
