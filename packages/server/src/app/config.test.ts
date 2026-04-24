import { describe, it, expect, afterEach } from "vitest";
import { Effect, Exit, Cause } from "effect";
import { ServerConfigLoader } from "./config.js";

afterEach(() => {
  // Clean up any env vars set by individual tests
  delete process.env["DATABASE_URL"];
  delete process.env["ENCRYPTION_MASTER_SECRET"];
  delete process.env["MOLTZAP_DEV_MODE"];
  delete process.env["PORT"];
  delete process.env["CORS_ORIGINS"];
});

/**
 * Extract a ConfigError failure from an Exit, failing the test if the exit
 * is not a failure or the cause is not a ConfigError.
 */
function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) throw new Error("expected failure, got success");
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some")
    throw new Error(`expected typed failure in cause, got ${exit.cause}`);
  return failure.value;
}

describe("ServerConfigLoader", () => {
  it("bare config (no env vars) boots with PGlite defaults + no encryption", async () => {
    // MOLTZAP_DEV_MODE defaults to false, but we need CORS_ORIGINS or devMode
    // to satisfy parseCorsOrigins. Use devMode=true for the quickstart path.
    process.env["MOLTZAP_DEV_MODE"] = "true";

    const result = await Effect.runPromise(ServerConfigLoader);

    expect(result.database.url).toBe(""); // empty string → PGlite in standalone
    expect(result.encryption.masterSecret).toBeUndefined();
    expect(result.server.port).toBe(3000);
    expect(result.devMode).toBe(true);
  });

  it("ENCRYPTION_MASTER_SECRET overrides the no-encryption default", async () => {
    process.env["MOLTZAP_DEV_MODE"] = "true";
    process.env["ENCRYPTION_MASTER_SECRET"] = "my-super-secret-key";

    const result = await Effect.runPromise(ServerConfigLoader);

    expect(result.encryption.masterSecret).toBe("my-super-secret-key");
  });

  it("DATABASE_URL overrides the PGlite default (Postgres opt-in)", async () => {
    process.env["MOLTZAP_DEV_MODE"] = "true";
    process.env["DATABASE_URL"] = "postgres://localhost:5432/moltzap";

    const result = await Effect.runPromise(ServerConfigLoader);

    expect(result.database.url).toBe("postgres://localhost:5432/moltzap");
    expect(result.encryption.masterSecret).toBeUndefined(); // encryption still optional
  });

  it("fails when CORS_ORIGINS is absent and devMode is false", async () => {
    // No MOLTZAP_DEV_MODE → devMode=false → parseCorsOrigins requires CORS_ORIGINS
    const exit = await Effect.runPromiseExit(ServerConfigLoader);

    const err = expectFailure(exit);
    expect(String(err)).toMatch(/CORS_ORIGINS/);
  });

  it("fails when DATABASE_URL points to Supabase in devMode", async () => {
    process.env["MOLTZAP_DEV_MODE"] = "true";
    process.env["DATABASE_URL"] =
      "postgres://user:pass@project.supabase.co:5432/postgres";

    const exit = await Effect.runPromiseExit(ServerConfigLoader);

    const err = expectFailure(exit);
    expect(String(err)).toMatch(/Supabase/);
  });

  it("respects PORT override", async () => {
    process.env["MOLTZAP_DEV_MODE"] = "true";
    process.env["PORT"] = "8080";

    const result = await Effect.runPromise(ServerConfigLoader);

    expect(result.server.port).toBe(8080);
  });

  it("parses CORS_ORIGINS in production mode (no devMode)", async () => {
    process.env["CORS_ORIGINS"] =
      "https://app.example.com,https://www.example.com";

    const result = await Effect.runPromise(ServerConfigLoader);

    expect(result.server.corsOrigins.exact).toEqual([
      "https://app.example.com",
      "https://www.example.com",
    ]);
    expect(result.devMode).toBe(false);
    expect(result.encryption.masterSecret).toBeUndefined();
  });
});
