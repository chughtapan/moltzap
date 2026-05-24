import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit, Option, type Scope } from "effect";
import { ConfigLoadError, loadStandaloneConfig } from "./config.js";

const it = effectIt.scoped;
const eff = effectIt.effect;

const CONFIG_FILE = "moltzap.yaml";
const TEMP_PREFIX = "moltzap-config-";

const PG_URL = "postgres://localhost:5432/moltzap";
const SUPABASE_URL = "postgres://u:p@x.supabase.co:5432/postgres";
const APP_ORIGIN = "https://app.example.com";
const WWW_ORIGIN = "https://www.example.com";
const SECRET = "secret-key";
const INTERPOLATED = "interpolated-value";
const SESSION_URL = "https://example.com/sessions";
const SESSION_TIMEOUT = 5000;
const DEFAULT_PORT = 3000;
const OVERRIDE_PORT = 8080;
const VALIDATION_ERROR_KIND: ConfigLoadError["kind"] = "validation";

const SESSIONS_YAML = `services:
  sessions:
    type: webhook
    webhook_url: ${SESSION_URL}
    timeout_ms: ${SESSION_TIMEOUT}
`;

const APPS_YAML = `apps:
  - manifest: ./app1.json
  - manifest: ./app2.json
`;

const INVALID_PORT_YAML = `server:
  port: -1
`;

const REUSED_ENV_KEY = "MOLTZAP_TEST_PATCH_KEY";
const REUSED_ENV_VALUE = "regression-352-value";
const REUSE_YAML = `registration:\n  secret: \${${REUSED_ENV_KEY}}\n`;

function envOnly(env: Record<string, string | undefined>) {
  return loadStandaloneConfig({ processEnv: env });
}

function expectFailureValue(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error(`expected typed failure in cause, got ${exit.cause}`);
  }
  return failure.value;
}

function withTempConfig<A, E>(
  body: string,
  run: (configPath: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | PlatformError, Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fs.makeTempDirectoryScoped({ prefix: TEMP_PREFIX });
    const configPath = path.join(tmpDir, CONFIG_FILE);
    yield* fs.writeFileString(configPath, body);
    return yield* run(configPath);
  }).pipe(Effect.provide(NodeContext.layer));
}

function devDefaults() {
  return Effect.gen(function* () {
    const result = yield* envOnly({ MOLTZAP_DEV_MODE: "true" });
    expect(result.databaseUrl).toBe("");
    expect(result.encryptionMasterSecret).toBeUndefined();
    expect(result.port).toBe(DEFAULT_PORT);
    expect(result.devMode).toBe(true);
    expect(result.corsOrigins).toEqual(["*"]);
  });
}

function encryptionSurfaces() {
  return Effect.gen(function* () {
    const result = yield* envOnly({
      MOLTZAP_DEV_MODE: "true",
      ENCRYPTION_MASTER_SECRET: SECRET,
    });
    expect(result.encryptionMasterSecret).toBe(SECRET);
  });
}

function databaseUrlOverride() {
  return Effect.gen(function* () {
    const result = yield* envOnly({
      MOLTZAP_DEV_MODE: "true",
      DATABASE_URL: PG_URL,
    });
    expect(result.databaseUrl).toBe(PG_URL);
  });
}

function portOverride() {
  return Effect.gen(function* () {
    const result = yield* envOnly({
      MOLTZAP_DEV_MODE: "true",
      PORT: String(OVERRIDE_PORT),
    });
    expect(result.port).toBe(OVERRIDE_PORT);
  });
}

function corsParsed() {
  return Effect.gen(function* () {
    const result = yield* envOnly({
      CORS_ORIGINS: `${APP_ORIGIN},${WWW_ORIGIN}`,
    });
    expect(result.corsOrigins).toEqual([APP_ORIGIN, WWW_ORIGIN]);
    expect(result.devMode).toBe(false);
  });
}

function corsRequiredInProd() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(envOnly({}));
    const err = expectFailureValue(exit);
    expect(String(err)).toMatch(/CORS_ORIGINS/);
  });
}

function supabaseRejected() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      envOnly({ MOLTZAP_DEV_MODE: "true", DATABASE_URL: SUPABASE_URL }),
    );
    const err = expectFailureValue(exit);
    expect(String(err)).toMatch(/Supabase/);
  });
}

function rejectsInvalidPort() {
  return withTempConfig(INVALID_PORT_YAML, (configPath) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadStandaloneConfig({
          configPath,
          processEnv: { CORS_ORIGINS: APP_ORIGIN },
        }),
      );
      const err = expectFailureValue(exit);
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).kind).toBe(VALIDATION_ERROR_KIND);
      expect((err as ConfigLoadError).configError).toBeDefined();
    }),
  );
}

const INTERPOLATION_YAML = `registration:\n  secret: \${MY_SECRET}\n`;

function envInterpolation() {
  return withTempConfig(INTERPOLATION_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: { MY_SECRET: INTERPOLATED, CORS_ORIGINS: APP_ORIGIN },
      });
      expect(result.registrationSecret).toBe(INTERPOLATED);
    }),
  );
}

function sessionsBinding() {
  return withTempConfig(SESSIONS_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: { CORS_ORIGINS: APP_ORIGIN },
      });
      expect(result.sessionWebhook).toEqual({
        url: SESSION_URL,
        timeoutMs: SESSION_TIMEOUT,
      });
      expect(result.contactWebhook).toBeUndefined();
    }),
  );
}

function appsPassthrough() {
  return withTempConfig(APPS_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: { CORS_ORIGINS: APP_ORIGIN },
      });
      expect(result.apps).toEqual([
        { manifest: "./app1.json" },
        { manifest: "./app2.json" },
      ]);
    }),
  );
}

// Regression: env interpolation reads from the snapshot but must not mutate
// the caller's `processEnv` object. A reused-by-reference snapshot keeps
// every key after interpolation and the `${VAR}` reference still resolves.
function doesNotMutateReusedEnv() {
  return withTempConfig(REUSE_YAML, (configPath) =>
    Effect.gen(function* () {
      const processEnv: Record<string, string | undefined> = {
        [REUSED_ENV_KEY]: REUSED_ENV_VALUE,
        MOLTZAP_DEV_MODE: "true",
      };
      const beforeKeys = Object.keys(processEnv).length;
      const result = yield* loadStandaloneConfig({ configPath, processEnv });
      expect(result.registrationSecret).toBe(REUSED_ENV_VALUE);
      expect(processEnv[REUSED_ENV_KEY]).toBe(REUSED_ENV_VALUE);
      expect(Object.keys(processEnv).length).toBe(beforeKeys);
    }),
  );
}

describe("loadStandaloneConfig env-only", () => {
  eff("PGlite default + no encryption under dev mode", devDefaults);
  eff("ENCRYPTION_MASTER_SECRET surfaces", encryptionSurfaces);
  eff("DATABASE_URL overrides the PGlite fallback", databaseUrlOverride);
  eff("PORT override respected", portOverride);
  eff("CORS_ORIGINS parsed as comma-separated list", corsParsed);
  eff("CORS_ORIGINS required outside dev mode", corsRequiredInProd);
  eff("Supabase rejected under dev mode", supabaseRejected);
});

describe("loadStandaloneConfig YAML", () => {
  it("rejects an out-of-range port with a validation ConfigLoadError", () =>
    rejectsInvalidPort());
  it("env interpolation: ${VAR} resolves against processEnv", envInterpolation);
  it(
    "services.sessions: webhook produces sessionWebhook binding",
    sessionsBinding,
  );
  it("apps[] passes through to bootPlan", appsPassthrough);
  it("does not mutate a reused processEnv during interpolation", () =>
    doesNotMutateReusedEnv());
});
