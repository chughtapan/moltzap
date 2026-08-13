import { it as effectIt } from "@effect/vitest";
import { describe, expect, vi } from "vitest";
import { FileSystem, Path } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit, Option, Redacted, type Scope } from "effect";
import { ConfigLoadError, loadStandaloneConfig } from "#config";

const it = effectIt.scoped;
const eff = effectIt.effect;

const CONFIG_FILE = "moltzap.yaml";
const TEMP_PREFIX = "moltzap-config-";

const APP_ORIGIN = "https://app.example.com";
const WWW_ORIGIN = "https://www.example.com";
const INTERPOLATED = "interpolated-value";
const DEFAULT_PORT = 3000;
const OVERRIDE_PORT = 8080;
const ADMIN_USER_ID = "00000000-0000-4000-8000-00000000ad01";
const VALIDATION_ERROR_KIND: ConfigLoadError["kind"] = "validation";

const INVALID_PORT_YAML = `server:
  port: -1
`;

const REUSED_ENV_KEY = "MOLTZAP_TEST_PATCH_KEY";
const REUSED_ENV_VALUE = "regression-352-value";
const REUSE_YAML = `registration:\n  secret: \${${REUSED_ENV_KEY}}\n`;

// Validation-parity fixtures. Each must FAIL with a validation
// ConfigLoadError — these are the structural rejections the prior Ajv
// schema enforced, now re-asserted via TypeBox Value.Check.

const UNKNOWN_TOPLEVEL_YAML = `server:\n  port: 3000\nbogus: true\n`;
const RETIRED_SEED_YAML = `database:\n  data_dir: ./data\nseed:\n  agents:\n    - name: alice\n`;
// Messages are stored plaintext; the retired `encryption` block must fail
// loudly rather than be read as an absent setting.
const RETIRED_ENCRYPTION_YAML = `encryption:\n  master_secret: a-real-secret\n`;
// App principals are gone; the retired `apps[]` block must fail the same way.
const RETIRED_APPS_YAML = `apps:\n  - manifest: ./app1.json\n`;
const UNKNOWN_NESTED_YAML = `server:\n  port: 3000\n  extra: nope\n`;
function envOnly(env: Record<string, string | undefined>) {
  return loadStandaloneConfig({
    processEnv: { MOLTZAP_ADMIN_USER_ID: ADMIN_USER_ID, ...env },
  });
}

function testEnv(env: Record<string, string | undefined> = {}) {
  return { MOLTZAP_ADMIN_USER_ID: ADMIN_USER_ID, ...env };
}

function expectFailureValue(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected failure");
  }
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
    expect(result.port).toBe(DEFAULT_PORT);
    expect(result.corsOrigins).toEqual(["*"]);
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
      MOLTZAP_REGISTRATION_SECRET: INTERPOLATED,
    });
    expect(result.corsOrigins).toEqual([APP_ORIGIN, WWW_ORIGIN]);
  });
}

// One anonymous registration yields an active agent that can enumerate the
// roster and broadcast into arbitrary conversations, so an unset secret must
// refuse to boot rather than serve open registration.
function registrationSecretRequiredInProd() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(envOnly({ CORS_ORIGINS: APP_ORIGIN }));
    const err = expectFailureValue(exit);
    expect(String(err)).toMatch(/registration secret/i);
  });
}

function registrationSecretFromEnvOnly() {
  return Effect.gen(function* () {
    const result = yield* envOnly({
      CORS_ORIGINS: APP_ORIGIN,
      MOLTZAP_REGISTRATION_SECRET: INTERPOLATED,
    });
    expect(result.registrationSecret).not.toBeUndefined();
    expect(
      Redacted.value(
        /* Safe because the test fixture establishes this asserted shape. */ result.registrationSecret!,
      ),
    ).toBe(INTERPOLATED);
  });
}

function corsRequiredInProd() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(envOnly({}));
    const err = expectFailureValue(exit);
    expect(String(err)).toMatch(/CORS_ORIGINS/);
  });
}

function rejectsInvalidPort() {
  return withTempConfig(INVALID_PORT_YAML, (configPath) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadStandaloneConfig({
          configPath,
          processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
        }),
      );
      const err = expectFailureValue(exit);
      expect(err).toBeInstanceOf(ConfigLoadError);
      // port: -1 is rejected by structural validation (TypeBox, minimum: 1)
      // before the Effect Config decode, so it surfaces as kind "validation".
      expect(
        /* Safe because the test fixture establishes this asserted shape. */
        (err as ConfigLoadError).kind,
      ).toBe(VALIDATION_ERROR_KIND);
    }),
  );
}

const INTERPOLATION_YAML = `registration:\n  secret: \${MY_SECRET}\n`;
const ENV_BACKED_REGISTRATION_YAML = `admin_user_id: ${ADMIN_USER_ID}
server:
  cors_origins:
    - ${APP_ORIGIN}
registration:
  secret: \${MOLTZAP_REGISTRATION_SECRET}
`;

function envInterpolation() {
  return withTempConfig(INTERPOLATION_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: testEnv({
          MY_SECRET: INTERPOLATED,
          CORS_ORIGINS: APP_ORIGIN,
        }),
      });
      expect(result.registrationSecret).not.toBeUndefined();
      expect(
        Redacted.value(
          /* Safe because the test fixture establishes this asserted shape. */ result.registrationSecret!,
        ),
      ).toBe(INTERPOLATED);
    }),
  );
}

function envBackedRegistrationInterpolation() {
  vi.stubEnv("MOLTZAP_REGISTRATION_SECRET", INTERPOLATED);
  return withTempConfig(ENV_BACKED_REGISTRATION_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({ configPath });
      expect(result.registrationSecret).not.toBeUndefined();
      expect(
        Redacted.value(
          /* Safe because the test fixture establishes this asserted shape. */ result.registrationSecret!,
        ),
      ).toBe(INTERPOLATED);
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.unstubAllEnvs();
      }),
    ),
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
        MOLTZAP_ADMIN_USER_ID: ADMIN_USER_ID,
      };
      const beforeKeys = Object.keys(processEnv).length;
      const result = yield* loadStandaloneConfig({ configPath, processEnv });
      expect(result.registrationSecret).not.toBeUndefined();
      expect(
        Redacted.value(
          /* Safe because the test fixture establishes this asserted shape. */ result.registrationSecret!,
        ),
      ).toBe(REUSED_ENV_VALUE);
      expect(processEnv[REUSED_ENV_KEY]).toBe(REUSED_ENV_VALUE);
      expect(Object.keys(processEnv).length).toBe(beforeKeys);
    }),
  );
}

// Asserts a YAML fixture is rejected with a validation ConfigLoadError.
function expectValidationRejection(body: string) {
  return withTempConfig(body, (configPath) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadStandaloneConfig({
          configPath,
          processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
        }),
      );
      const err = expectFailureValue(exit);
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */
        (err as ConfigLoadError).kind,
      ).toBe(VALIDATION_ERROR_KIND);
    }),
  );
}

describe("loadStandaloneConfig env-only", () => {
  eff("PGlite default under dev mode", devDefaults);
  eff("PORT override respected", portOverride);
  eff("CORS_ORIGINS parsed as comma-separated list", corsParsed);
  eff("CORS_ORIGINS required outside dev mode", corsRequiredInProd);
  eff(
    "registration secret required outside dev mode",
    registrationSecretRequiredInProd,
  );
  eff(
    "MOLTZAP_REGISTRATION_SECRET alone satisfies the production guard",
    registrationSecretFromEnvOnly,
  );
});

describe("loadStandaloneConfig YAML", () => {
  it("rejects an out-of-range port with a validation ConfigLoadError", () =>
    rejectsInvalidPort());
  it("env interpolation: ${VAR} resolves against processEnv", envInterpolation);
  it(
    "loads the registration secret used by env-backed YAML interpolation",
    envBackedRegistrationInterpolation,
  );
  it("does not mutate a reused processEnv during interpolation", () =>
    doesNotMutateReusedEnv());
});

// Validation parity with main's Ajv schema: every rejection the prior
// Ajv/TypeBox schema enforced is re-asserted here. The mechanism is now
// TypeBox Value.Check (Ajv is gone), but the structural rejections match.
// @agent-code-guard/regression-only: each case pins a specific structural rejection the prior Ajv schema enforced (recovered from the deleted config/schema.test.ts), so the Ajv→TypeBox swap cannot silently relax validation
describe("loadStandaloneConfig validation parity", () => {
  it("rejects the retired encryption block", () =>
    expectValidationRejection(RETIRED_ENCRYPTION_YAML));
  it("rejects the retired apps block", () =>
    expectValidationRejection(RETIRED_APPS_YAML));
  it("rejects unknown top-level keys", () =>
    expectValidationRejection(UNKNOWN_TOPLEVEL_YAML));
  it("rejects the retired seed block", () =>
    expectValidationRejection(RETIRED_SEED_YAML));
  it("rejects unknown nested keys", () =>
    expectValidationRejection(UNKNOWN_NESTED_YAML));
});
