import { describe, it, expect } from "vitest";
import { validateConfig, formatConfigErrors } from "./schema.js";

const MINIMAL_CONFIG = {
  database: { url: "postgres://localhost:5432/moltzap" },
};

describe("validateConfig", () => {
  it("accepts empty config (PGlite default)", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.database).toBeUndefined();
    }
  });

  it("accepts config with database URL", () => {
    const result = validateConfig(MINIMAL_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.database?.url).toBe(
        "postgres://localhost:5432/moltzap",
      );
    }
  });

  it("accepts full config with all fields", () => {
    const full = {
      ...MINIMAL_CONFIG,
      server: { port: 3000, cors_origins: ["https://app.example.com"] },
      services: {
        users: { type: "in_process" },
        contacts: {
          type: "webhook",
          webhook_url: "https://hooks.example.com/contacts",
          timeout_ms: 5000,
        },
        permissions: {
          type: "webhook",
          webhook_url: "https://hooks.example.com/perms",
          callback_token: "tok",
        },
      },
      registration: { secret: "reg-secret" },
      seed: {
        agents: [{ name: "bot-1", description: "A test bot" }],
        onboarding_message: "Welcome!",
      },
      apps: [{ manifest: "https://example.com/manifest.json" }],
      log_level: "debug",
    };
    const result = validateConfig(full);
    expect(result.ok).toBe(true);
  });

  it("rejects empty database url string", () => {
    const result = validateConfig({ database: { url: "" } });
    expect(result.ok).toBe(false);
  });

  it("accepts config with encryption", () => {
    const result = validateConfig({
      database: { url: "pg://x" },
      encryption: { master_secret: "test-key" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.encryption?.master_secret).toBe("test-key");
    }
  });

  it("rejects invalid field types", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      server: { port: "not-a-number" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown top-level fields", () => {
    const result = validateConfig({ ...MINIMAL_CONFIG, bogus: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.problem.includes("bogus"))).toBe(true);
    }
  });

  it("rejects unknown nested fields", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      server: { port: 3000, extra: "nope" },
    });
    expect(result.ok).toBe(false);
  });

  it("validates log_level enum", () => {
    const valid = validateConfig({ ...MINIMAL_CONFIG, log_level: "warn" });
    expect(valid.ok).toBe(true);

    const invalid = validateConfig({ ...MINIMAL_CONFIG, log_level: "verbose" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((e) => e.expected.includes("debug"))).toBe(
        true,
      );
    }
  });

  it("validates service type enum", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      services: { users: { type: "grpc" } },
    });
    expect(result.ok).toBe(false);
  });

  it("validates webhook_url format", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      services: { users: { type: "webhook", webhook_url: "not-a-url" } },
    });
    expect(result.ok).toBe(false);
  });

  it("validates port range", () => {
    const tooLow = validateConfig({ ...MINIMAL_CONFIG, server: { port: 0 } });
    expect(tooLow.ok).toBe(false);

    const tooHigh = validateConfig({
      ...MINIMAL_CONFIG,
      server: { port: 70000 },
    });
    expect(tooHigh.ok).toBe(false);
  });

  it("rejects empty database url", () => {
    const result = validateConfig({
      database: { url: "" },
    });
    expect(result.ok).toBe(false);
  });

  it("deduplicates errors from union schemas", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      services: { users: { type: "webhook" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => `${e.path}::${e.problem}`);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
});

describe("formatConfigErrors", () => {
  it("produces readable multi-line output", () => {
    const output = formatConfigErrors([
      {
        path: "/database",
        problem: 'Missing required field "url"',
        expected: 'Property "url" must be provided',
        example: '"postgres://..."',
      },
    ]);
    expect(output).toContain("/database");
    expect(output).toContain("Missing required field");
    expect(output).toContain("Expected:");
    expect(output).toContain("Example:");
    expect(output).toContain("postgres://");
  });

  it("omits example line when not provided", () => {
    const output = formatConfigErrors([
      { path: "/foo", problem: "bad", expected: "good" },
    ]);
    expect(output).not.toContain("Example:");
  });

  it("formats multiple errors separated by blank lines", () => {
    const output = formatConfigErrors([
      { path: "/a", problem: "p1", expected: "e1" },
      { path: "/b", problem: "p2", expected: "e2" },
    ]);
    expect(output).toContain("\n\n");
  });
});
