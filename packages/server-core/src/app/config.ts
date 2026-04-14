function requireEnv(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

export interface CorsConfig {
  exact: string[];
  patterns: RegExp[];
}

export interface LoadedConfig {
  database: {
    url: string;
  };
  encryption: {
    masterSecret: string;
  };
  server: {
    port: number;
    corsOrigins: CorsConfig;
  };
  devMode: boolean;
}

/** Type alias so copied infrastructure files (e.g. db/client.ts) compile without changes. */
export type ServerConfig = LoadedConfig;

export function loadCoreConfig(): LoadedConfig {
  const devMode = process.env["MOLTZAP_DEV_MODE"] === "true";

  const databaseUrl = devMode
    ? (optionalEnv("DATABASE_URL") ?? "")
    : requireEnv("DATABASE_URL");

  if (devMode && databaseUrl.includes(".supabase.co")) {
    throw new Error(
      "MOLTZAP_DEV_MODE=true cannot be used with a Supabase-hosted database",
    );
  }

  return {
    database: {
      url: databaseUrl,
    },
    encryption: {
      masterSecret: requireEnv("ENCRYPTION_MASTER_SECRET"),
    },
    server: {
      port: parseInt(requireEnv("PORT", "3000")),
      corsOrigins: parseCorsOrigins(optionalEnv("CORS_ORIGINS"), devMode),
    },
    devMode,
  };
}

function parseCorsOrigins(
  raw: string | undefined,
  devMode: boolean,
): CorsConfig {
  if (!raw) {
    if (devMode) return { exact: ["*"], patterns: [] };
    throw new Error(
      "CORS_ORIGINS is required in production. Set to comma-separated origins, use regex: prefix for patterns.",
    );
  }
  const exact: string[] = [];
  const patterns: RegExp[] = [];
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (entry.startsWith("regex:")) {
      try {
        patterns.push(new RegExp(`^${entry.slice(6)}$`));
      } catch (err) {
        throw new Error(
          `Invalid regex in CORS_ORIGINS: "${entry.slice(6)}" — ${err}`,
        );
      }
    } else {
      exact.push(entry);
    }
  }
  return { exact, patterns };
}
