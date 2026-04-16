import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfigFromFile, ConfigLoadError } from "./loader.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const VALID_YAML = `
database:
  url: postgres://localhost:5432/moltzap
encryption:
  master_secret: my-secret
`;

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfigFromFile", () => {
  it("loads valid YAML and returns parsed config", () => {
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    const config = loadConfigFromFile("test.yaml");
    expect(config.database.url).toBe("postgres://localhost:5432/moltzap");
    expect(config.encryption.master_secret).toBe("my-secret");
  });

  it("interpolates ${ENV_VAR} references", () => {
    vi.stubEnv("TEST_DB_URL", "postgres://prod:5432/db");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: \${TEST_DB_URL}
encryption:
  master_secret: secret
`);

    const config = loadConfigFromFile("test.yaml");
    expect(config.database.url).toBe("postgres://prod:5432/db");
  });

  it("interpolates multiple env vars in one string", () => {
    vi.stubEnv("DB_HOST", "myhost");
    vi.stubEnv("DB_PORT", "5433");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: postgres://\${DB_HOST}:\${DB_PORT}/moltzap
encryption:
  master_secret: secret
`);

    const config = loadConfigFromFile("test.yaml");
    expect(config.database.url).toBe("postgres://myhost:5433/moltzap");
  });

  it("throws ConfigLoadError for missing env var", () => {
    delete process.env["MISSING_VAR"];
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: \${MISSING_VAR}
encryption:
  master_secret: secret
`);

    expect(() => loadConfigFromFile("test.yaml")).toThrow(ConfigLoadError);
    expect(() => loadConfigFromFile("test.yaml")).toThrow("MISSING_VAR");
  });

  it("throws ConfigLoadError for invalid YAML", () => {
    vi.mocked(readFileSync).mockReturnValue("{{{{not yaml");

    expect(() => loadConfigFromFile("test.yaml")).toThrow(ConfigLoadError);
    expect(() => loadConfigFromFile("test.yaml")).toThrow("Invalid YAML");
  });

  it("throws ConfigLoadError for missing file", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(() => loadConfigFromFile("missing.yaml")).toThrow(ConfigLoadError);
    expect(() => loadConfigFromFile("missing.yaml")).toThrow(
      "Cannot read config file",
    );
  });

  it("throws ConfigLoadError with errors array for schema validation failure", () => {
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: postgres://localhost/db
`);

    try {
      loadConfigFromFile("test.yaml");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      const loadErr = err as ConfigLoadError;
      expect(loadErr.errors).toBeDefined();
      expect(loadErr.errors!.length).toBeGreaterThan(0);
      expect(loadErr.errors!.some((e) => e.path.includes("encryption"))).toBe(
        true,
      );
    }
  });

  it("defaults to MOLTZAP_CONFIG env var when no path given", () => {
    vi.stubEnv("MOLTZAP_CONFIG", "custom.yaml");
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    loadConfigFromFile();
    expect(readFileSync).toHaveBeenCalledWith("custom.yaml", "utf-8");
  });

  it("defaults to moltzap.yaml when no path and no env var", () => {
    delete process.env["MOLTZAP_CONFIG"];
    vi.mocked(readFileSync).mockReturnValue(VALID_YAML);

    loadConfigFromFile();
    expect(readFileSync).toHaveBeenCalledWith("moltzap.yaml", "utf-8");
  });

  it("interpolates env vars inside arrays", () => {
    vi.stubEnv("ORIGIN", "https://app.example.com");
    vi.mocked(readFileSync).mockReturnValue(`
database:
  url: pg://localhost/db
encryption:
  master_secret: secret
server:
  cors_origins:
    - \${ORIGIN}
`);

    const config = loadConfigFromFile("test.yaml");
    expect(config.server?.cors_origins).toEqual(["https://app.example.com"]);
  });
});
