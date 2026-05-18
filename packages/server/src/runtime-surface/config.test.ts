import { it as effectIt } from "@effect/vitest";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Effect, type Scope } from "effect";
import { describe, expect } from "vitest";
import { loadRuntimeProcessConfig, runtimeConfigPath } from "./config.js";

const it = effectIt.scoped;

const CONFIG_FILE_NAME = "moltzap.yaml";
const TEMP_DIR_PREFIX = "moltzap-runtime-config-";
const ENV_KEY = "MOLTZAP_TEST_PATCH_KEY";
const ENV_VALUE = "regression-352-value";
const DEV_MODE_KEY = "MOLTZAP_DEV_MODE";
const DEV_MODE_ENABLED = "true";
const REGISTRATION_SECRET_YAML = `registration:\n  secret: \${${ENV_KEY}}\n`;

/**
 * Regression: the env interpolation path used to mutate the same env object it
 * was reading from. Passing the same env reference into runtime loading must
 * preserve every key and still make `${VAR}` interpolation work.
 */
describe("loadRuntimeProcessConfig env interpolation", () => {
  it(
    "does not lose keys when processEnv is reused by reference",
    sameReferenceEnv,
  );

  it("works when processEnv is a separate snapshot", separateEnvSnapshot);
});

function sameReferenceEnv() {
  return withTempConfigFile(REGISTRATION_SECRET_YAML, (configPath) =>
    Effect.gen(function* () {
      const processEnv = runtimeEnv();
      const beforeKeys = Object.keys(processEnv).length;

      const result = yield* loadRuntimeProcessConfig({
        configPath: runtimeConfigPath(configPath),
        processEnv,
      });

      expect(result.app.registration?.secret).toBe(ENV_VALUE);
      expect(processEnv[ENV_KEY]).toBe(ENV_VALUE);
      expect(Object.keys(processEnv).length).toBe(beforeKeys);
    }),
  );
}

function separateEnvSnapshot() {
  return withTempConfigFile(REGISTRATION_SECRET_YAML, (configPath) =>
    Effect.gen(function* () {
      const originalEnv = runtimeEnv();
      const snapshot = { ...originalEnv };
      const result = yield* loadRuntimeProcessConfig({
        configPath: runtimeConfigPath(configPath),
        processEnv: snapshot,
      });

      expect(result.app.registration?.secret).toBe(ENV_VALUE);
      expect(originalEnv[ENV_KEY]).toBe(ENV_VALUE);
    }),
  );
}

function runtimeEnv(): Record<string, string | undefined> {
  return {
    [ENV_KEY]: ENV_VALUE,
    [DEV_MODE_KEY]: DEV_MODE_ENABLED,
  };
}

function withTempConfigFile<A, E>(
  body: string,
  run: (configPath: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fs.makeTempDirectoryScoped({
      prefix: TEMP_DIR_PREFIX,
    });
    const configPath = path.join(tmpDir, CONFIG_FILE_NAME);
    yield* fs.writeFileString(configPath, body);
    return yield* run(configPath);
  }).pipe(Effect.provide(NodeContext.layer));
}
