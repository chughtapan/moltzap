import { describe, it, expect } from "vitest";
import { validateConfig, formatConfigErrors } from "./schema.js";

const DATABASE_URL = "postgres://localhost:5432/moltzap";
const ENCRYPTION_SECRET = "test-key";
const DATABASE_PATH = "/database";
const MISSING_REQUIRED_FIELD_TEXT = "Missing required field";
const EXPECTED_LABEL = "Expected:";
const EXAMPLE_LABEL = "Example:";
const POSTGRES_PREFIX = "postgres://";

const MINIMAL_CONFIG = {
  database: { url: DATABASE_URL },
};

describe("validateConfig accepted configs", () => {
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
      expect(result.config.database?.url).toBe(DATABASE_URL);
    }
  });

  it("accepts full config with all fields", () => {
    const full = {
      ...MINIMAL_CONFIG,
      server: { port: 3000, cors_origins: ["https://app.example.com"] },
      services: {
        sessions: { type: "in_process" },
        contacts: {
          type: "webhook",
          webhook_url: "https://hooks.example.com/contacts",
          timeout_ms: 5000,
        },
      },
      registration: { secret: "reg-secret" },
      apps: [{ manifest: "https://example.com/manifest.json" }],
      log_level: "debug",
    };
    const result = validateConfig(full);
    expect(result.ok).toBe(true);
  });
});

describe("validateConfig field basics", () => {
  it("rejects retired `seed` block (agents are minted via /api/v1/admin/register-agent)", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      seed: { agents: [{ name: "alice" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.problem.includes("seed"))).toBe(true);
    }
  });

  it("rejects empty database url string", () => {
    const result = validateConfig({ database: { url: "" } });
    expect(result.ok).toBe(false);
  });

  it("accepts config with encryption", () => {
    const result = validateConfig({
      database: { url: "pg://x" },
      encryption: { master_secret: ENCRYPTION_SECRET },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.encryption?.master_secret).toBe(ENCRYPTION_SECRET);
    }
  });
});

describe("validateConfig unknown and type rejection", () => {
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
});

describe("validateConfig enum and service constraints", () => {
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
      services: { sessions: { type: "grpc" } },
    });
    expect(result.ok).toBe(false);
  });

  it("validates webhook_url format", () => {
    const result = validateConfig({
      ...MINIMAL_CONFIG,
      services: { sessions: { type: "webhook", webhook_url: "not-a-url" } },
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateConfig range and dedupe constraints", () => {
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
      services: { sessions: { type: "webhook" } },
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
        path: DATABASE_PATH,
        problem: 'Missing required field "url"',
        expected: 'Property "url" must be provided',
        example: '"postgres://..."',
      },
    ]);
    expect(output).toContain(DATABASE_PATH);
    expect(output).toContain(MISSING_REQUIRED_FIELD_TEXT);
    expect(output).toContain(EXPECTED_LABEL);
    expect(output).toContain(EXAMPLE_LABEL);
    expect(output).toContain(POSTGRES_PREFIX);
  });

  it("omits example line when not provided", () => {
    const output = formatConfigErrors([
      { path: "/foo", problem: "bad", expected: "good" },
    ]);
    expect(output).not.toContain(EXAMPLE_LABEL);
  });

  it("formats multiple errors separated by blank lines", () => {
    const output = formatConfigErrors([
      { path: "/a", problem: "p1", expected: "e1" },
      { path: "/b", problem: "p2", expected: "e2" },
    ]);
    expect(output).toContain("\n\n");
  });
});
