import { Config, ConfigError, Effect, Option } from "effect";

export interface CorsConfig {
  exact: string[];
  patterns: RegExp[];
}

export interface LoadedConfig {
  database: {
    url: string;
  };
  encryption: {
    /**
     * Derived from `ENCRYPTION_MASTER_SECRET`. When absent, the encryption
     * layer is disabled and messages are stored as plaintext. Operators who
     * want at-rest encryption must set this env var.
     */
    masterSecret: string | undefined;
  };
  server: {
    port: number;
    corsOrigins: CorsConfig;
  };
  devMode: boolean;
}

/** Type alias so copied infrastructure files (e.g. db/client.ts) compile without changes. */
export type ServerConfig = LoadedConfig;

const parseCorsOrigins = (
  raw: string | undefined,
  devMode: boolean,
): Effect.Effect<CorsConfig, ConfigError.ConfigError> =>
  Effect.gen(function* () {
    if (!raw) {
      if (devMode) return { exact: ["*"], patterns: [] };
      return yield* Effect.fail(
        ConfigError.MissingData(
          ["CORS_ORIGINS"],
          "CORS_ORIGINS is required in production. Set to comma-separated origins, use regex: prefix for patterns.",
        ),
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
          return yield* Effect.fail(
            ConfigError.InvalidData(
              ["CORS_ORIGINS"],
              `Invalid regex in CORS_ORIGINS: "${entry.slice(6)}" — ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      } else {
        exact.push(entry);
      }
    }
    return { exact, patterns };
  });

/**
 * Effect-native server config loader. Reads env vars through `Config` so
 * missing/invalid values surface as typed `ConfigError` instead of thrown
 * `Error`. Callers already inside an Effect program `yield*` this; the one
 * sync entrypoint (`loadCoreConfig`) bridges via `Effect.runSync`.
 */
export const ServerConfigLoader: Effect.Effect<
  LoadedConfig,
  ConfigError.ConfigError
> = Effect.gen(function* () {
  const devMode = yield* Config.boolean("MOLTZAP_DEV_MODE").pipe(
    Config.withDefault(false),
  );

  const databaseUrl = yield* Config.string("DATABASE_URL").pipe(
    Config.withDefault(""),
  );

  if (devMode && databaseUrl.includes(".supabase.co")) {
    return yield* Effect.fail(
      ConfigError.InvalidData(
        ["DATABASE_URL"],
        "MOLTZAP_DEV_MODE=true cannot be used with a Supabase-hosted database",
      ),
    );
  }

  const masterSecret = Option.getOrUndefined(
    yield* Config.option(Config.string("ENCRYPTION_MASTER_SECRET")),
  );

  const port = yield* Config.integer("PORT").pipe(Config.withDefault(3000));
  const corsRawOpt = yield* Config.option(Config.string("CORS_ORIGINS"));
  const corsOrigins = yield* parseCorsOrigins(
    Option.getOrUndefined(corsRawOpt),
    devMode,
  );

  return {
    database: { url: databaseUrl },
    encryption: { masterSecret },
    server: { port, corsOrigins },
    devMode,
  };
});

/**
 * Sync facade for the one boot entry (`app/dev.ts`) that runs outside an
 * Effect program. Safe here because this is the absolute process entrypoint:
 * a `ConfigError` bubbles up as an unhandled exception and fails startup —
 * the same outcome the previous throw-based loader produced.
 */
export function loadCoreConfig(): LoadedConfig {
  return Effect.runSync(ServerConfigLoader);
}
