import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Cause, ConfigProvider, Effect, Exit, Option } from "effect";
import { ServerConfigLoader } from "./config.js";

const it = effectIt.effect;

const DEFAULT_SERVER_PORT = 3000;
const OVERRIDE_SERVER_PORT = 8080;
const DEV_MODE_KEY = "MOLTZAP_DEV_MODE";
const DATABASE_URL_KEY = "DATABASE_URL";
const ENCRYPTION_SECRET_KEY = "ENCRYPTION_MASTER_SECRET";
const PORT_KEY = "PORT";
const CORS_ORIGINS_KEY = "CORS_ORIGINS";
const DEV_MODE_ENABLED = "true";
const SECRET_VALUE = "my-super-secret-key";
const POSTGRES_URL = "postgres://localhost:5432/moltzap";
const SUPABASE_URL = "postgres://user:pass@project.supabase.co:5432/postgres";
const APP_ORIGIN = "https://app.example.com";
const WWW_ORIGIN = "https://www.example.com";

function loadWith(input: Record<string, string>) {
  return ServerConfigLoader.pipe(
    Effect.withConfigProvider(ConfigProvider.fromJson(input)),
  );
}

function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success");
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error(`expected typed failure in cause, got ${exit.cause}`);
  }
  return failure.value;
}

describe("ServerConfigLoader defaults and overrides", () => {
  it(
    "bare config boots with PGlite defaults + no encryption under dev mode",
    loadsDevDefaults,
  );
  it("ENCRYPTION_MASTER_SECRET overrides no-encryption", loadsSecret);
  it("DATABASE_URL overrides the PGlite default", loadsDatabaseUrl);
  it("respects PORT override", loadsPortOverride);
});

describe("ServerConfigLoader rejection cases", () => {
  it("fails when CORS_ORIGINS is absent and devMode is false", rejectsNoCors);
  it("fails when DATABASE_URL points to Supabase in devMode", rejectsSupabase);
});

describe("ServerConfigLoader CORS parsing", () => {
  it("parses CORS_ORIGINS in production mode", parsesCorsOrigins);
});

function loadsDevDefaults() {
  return Effect.gen(function* () {
    const result = yield* loadWith({ [DEV_MODE_KEY]: DEV_MODE_ENABLED });

    expect(result.database.url).toBe("");
    expect(result.encryption.masterSecret).toBeUndefined();
    expect(result.server.port).toBe(DEFAULT_SERVER_PORT);
    expect(result.devMode).toBe(true);
  });
}

function loadsSecret() {
  return Effect.gen(function* () {
    const result = yield* loadWith({
      [DEV_MODE_KEY]: DEV_MODE_ENABLED,
      [ENCRYPTION_SECRET_KEY]: SECRET_VALUE,
    });

    expect(result.encryption.masterSecret).toBe(SECRET_VALUE);
  });
}

function loadsDatabaseUrl() {
  return Effect.gen(function* () {
    const result = yield* loadWith({
      [DEV_MODE_KEY]: DEV_MODE_ENABLED,
      [DATABASE_URL_KEY]: POSTGRES_URL,
    });

    expect(result.database.url).toBe(POSTGRES_URL);
    expect(result.encryption.masterSecret).toBeUndefined();
  });
}

function rejectsNoCors() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(loadWith({}));
    const err = expectFailure(exit);
    expect(String(err)).toMatch(/CORS_ORIGINS/);
  });
}

function rejectsSupabase() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      loadWith({
        [DEV_MODE_KEY]: DEV_MODE_ENABLED,
        [DATABASE_URL_KEY]: SUPABASE_URL,
      }),
    );
    const err = expectFailure(exit);
    expect(String(err)).toMatch(/Supabase/);
  });
}

function loadsPortOverride() {
  return Effect.gen(function* () {
    const result = yield* loadWith({
      [DEV_MODE_KEY]: DEV_MODE_ENABLED,
      [PORT_KEY]: String(OVERRIDE_SERVER_PORT),
    });

    expect(result.server.port).toBe(OVERRIDE_SERVER_PORT);
  });
}

function parsesCorsOrigins() {
  return Effect.gen(function* () {
    const result = yield* loadWith({
      [CORS_ORIGINS_KEY]: `${APP_ORIGIN},${WWW_ORIGIN}`,
    });

    expect(result.server.corsOrigins.exact).toEqual([APP_ORIGIN, WWW_ORIGIN]);
    expect(result.devMode).toBe(false);
    expect(result.encryption.masterSecret).toBeUndefined();
  });
}
