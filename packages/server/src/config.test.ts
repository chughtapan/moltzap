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

const PG_URL = "postgres://localhost:5432/moltzap";
const SUPABASE_URL = "postgres://u:p@x.supabase.co:5432/postgres";
const APP_ORIGIN = "https://app.example.com";
const WWW_ORIGIN = "https://www.example.com";
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const INTERPOLATED = "interpolated-value";
const DEFAULT_PORT = 3000;
const OVERRIDE_PORT = 8080;
const ADMIN_USER_ID = "00000000-0000-4000-8000-00000000ad01";
const VALIDATION_ERROR_KIND: ConfigLoadError["kind"] = "validation";

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

const CONTACT_URL = "https://example.com/contacts";
const CONTACT_TIMEOUT = 7000;
const CALLBACK_TOKEN = "cb-token-123";

// Validation-parity fixtures. Each must FAIL with a validation
// ConfigLoadError — these are the structural rejections the prior Ajv
// schema enforced, now re-asserted via TypeBox Value.Check.

// encryption block present but master_secret missing → silently disabling
// at-rest encryption is the security regression this guards against.
const ENCRYPTION_EMPTY_YAML = `encryption: {}\n`;
// camelCase typo: `masterSecret` is an unknown key AND master_secret is
// absent. Must error, not silently store plaintext.
const ENCRYPTION_CAMELCASE_YAML = `encryption:\n  masterSecret: a-real-secret\n`;
const UNKNOWN_TOPLEVEL_YAML = `database:\n  url: ${PG_URL}\nbogus: true\n`;
const RETIRED_SEED_YAML = `database:\n  url: ${PG_URL}\nseed:\n  agents:\n    - name: alice\n`;
const UNKNOWN_NESTED_YAML = `server:\n  port: 3000\n  extra: nope\n`;
const BAD_WEBHOOK_URL_YAML = `services:\n  contacts:\n    type: webhook\n    webhook_url: not-a-url\n`;
const SMALL_TIMEOUT_YAML = `services:\n  contacts:\n    type: webhook\n    webhook_url: ${CONTACT_URL}\n    timeout_ms: 50\n`;
const BAD_SERVICE_TYPE_YAML = `services:\n  contacts:\n    type: grpc\n`;
// Empty database.url must FAIL (minLength: 1) rather than be read as a
// blank URL — main's Ajv rejected it; an empty string here is a typo, not
// a request for the PGlite fallback (that path is "no database.url at all").
const EMPTY_DB_URL_YAML = `database:\n  url: ""\n`;

const CONTACTS_YAML = `services:
  contacts:
    type: webhook
    webhook_url: ${CONTACT_URL}
    timeout_ms: ${CONTACT_TIMEOUT}
`;

const CONTACT_WITH_CALLBACK_YAML = `services:
  contacts:
    type: webhook
    webhook_url: ${CONTACT_URL}
    timeout_ms: ${CONTACT_TIMEOUT}
    callback_token: ${CALLBACK_TOKEN}
`;

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
    expect(result.encryptionMasterSecret).not.toBeUndefined();
    expect(
      Redacted.value(
        /* Safe because the test fixture establishes this asserted shape. */ result.encryptionMasterSecret!,
      ),
    ).toBe(SECRET);
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
          processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
        }),
      );
      const err = expectFailureValue(exit);
      expect(err).toBeInstanceOf(ConfigLoadError);
      // port: -1 is rejected by structural validation (TypeBox, minimum: 1)
      // before the Effect Config decode, so it surfaces as kind "validation".
      expect(
        (
          /* Safe because the test fixture establishes this asserted shape. */
          err as ConfigLoadError
        ).kind,
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

function appsPassthrough() {
  return withTempConfig(APPS_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
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
        (
          /* Safe because the test fixture establishes this asserted shape. */
          err as ConfigLoadError
        ).kind,
      ).toBe(VALIDATION_ERROR_KIND);
    }),
  );
}

function contactsBinding() {
  return withTempConfig(CONTACTS_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
      });
      expect(result.contactWebhook).toEqual({
        url: CONTACT_URL,
        timeoutMs: CONTACT_TIMEOUT,
      });
    }),
  );
}

function contactCallbackTokenBothPresent() {
  return withTempConfig(CONTACT_WITH_CALLBACK_YAML, (configPath) =>
    Effect.gen(function* () {
      const result = yield* loadStandaloneConfig({
        configPath,
        processEnv: testEnv({ CORS_ORIGINS: APP_ORIGIN }),
      });
      // The shared webhook parser accepts both timeout_ms and
      // callback_token; both present must survive the YAML service decode
      // (regression: an earlier projection dropped callback_token whenever
      // timeout_ms was also set). callback_token is not projected into the
      // boot-plan binding, so only the url + timeoutMs surface.
      expect(result.contactWebhook).toEqual({
        url: CONTACT_URL,
        timeoutMs: CONTACT_TIMEOUT,
      });
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
    "loads the registration secret used by env-backed YAML interpolation",
    envBackedRegistrationInterpolation,
  );
  it("apps[] passes through to bootPlan", appsPassthrough);
  it(
    "services.contacts: webhook produces contactWebhook binding",
    contactsBinding,
  );
  it(
    "services.contacts: keeps both timeout_ms and callback_token",
    contactCallbackTokenBothPresent,
  );
  it("does not mutate a reused processEnv during interpolation", () =>
    doesNotMutateReusedEnv());
});

// Validation parity with main's Ajv schema: every rejection the prior
// Ajv/TypeBox schema enforced is re-asserted here. The mechanism is now
// TypeBox Value.Check (Ajv is gone), but the structural rejections match.
// @agent-code-guard/regression-only: each case pins a specific structural rejection the prior Ajv schema enforced (recovered from the deleted config/schema.test.ts), so the Ajv→TypeBox swap cannot silently relax validation
describe("loadStandaloneConfig validation parity", () => {
  it("rejects encryption: {} (master_secret required when block present)", () =>
    expectValidationRejection(ENCRYPTION_EMPTY_YAML));
  it("rejects camelCase masterSecret typo (unknown key + missing required)", () =>
    expectValidationRejection(ENCRYPTION_CAMELCASE_YAML));
  it("rejects unknown top-level keys", () =>
    expectValidationRejection(UNKNOWN_TOPLEVEL_YAML));
  it("rejects the retired seed block", () =>
    expectValidationRejection(RETIRED_SEED_YAML));
  it("rejects unknown nested keys", () =>
    expectValidationRejection(UNKNOWN_NESTED_YAML));
  it("rejects a malformed webhook_url", () =>
    expectValidationRejection(BAD_WEBHOOK_URL_YAML));
  it("rejects timeout_ms below the 100ms minimum", () =>
    expectValidationRejection(SMALL_TIMEOUT_YAML));
  it("rejects an unknown service type", () =>
    expectValidationRejection(BAD_SERVICE_TYPE_YAML));
  it("rejects an empty database.url string", () =>
    expectValidationRejection(EMPTY_DB_URL_YAML));
});
