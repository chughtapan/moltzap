import { Config, ConfigError, Effect, Option, Redacted } from "effect";

interface CorsConfig {
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

const CORS_REGEX_PREFIX = "regex:";
const DEFAULT_SERVER_PORT = 3000;

const missingCorsOrigins = ConfigError.MissingData(
  ["CORS_ORIGINS"],
  "CORS_ORIGINS is required in production. Set to comma-separated origins, use regex: prefix for patterns.",
);

const splitCorsOrigins = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const readCorsOriginEntries = (
  raw: string | undefined,
  devMode: boolean,
): Effect.Effect<string[], ConfigError.ConfigError> => {
  if (raw) {
    return Effect.succeed(splitCorsOrigins(raw));
  }
  if (devMode) {
    return Effect.succeed(["*"]);
  }
  return Effect.fail(missingCorsOrigins);
};

const invalidCorsRegex = (
  pattern: string,
  cause: unknown,
): ConfigError.ConfigError =>
  ConfigError.InvalidData(
    ["CORS_ORIGINS"],
    `Invalid regex in CORS_ORIGINS: "${pattern}" — ${cause instanceof Error ? cause.message : String(cause)}`,
  );

const compileCorsPattern = (
  entry: string,
): Effect.Effect<RegExp, ConfigError.ConfigError> => {
  const pattern = entry.slice(CORS_REGEX_PREFIX.length);
  return Effect.try({
    try: () => new RegExp(`^${pattern}$`),
    catch: (cause) => invalidCorsRegex(pattern, cause),
  });
};

const appendCorsEntry = (
  config: CorsConfig,
  entry: string,
): Effect.Effect<CorsConfig, ConfigError.ConfigError> => {
  if (!entry.startsWith(CORS_REGEX_PREFIX)) {
    return Effect.succeed({ ...config, exact: [...config.exact, entry] });
  }
  return compileCorsPattern(entry).pipe(
    Effect.map((pattern) => ({
      ...config,
      patterns: [...config.patterns, pattern],
    })),
  );
};

const parseCorsOrigins = (
  raw: string | undefined,
  devMode: boolean,
): Effect.Effect<CorsConfig, ConfigError.ConfigError> =>
  readCorsOriginEntries(raw, devMode).pipe(
    Effect.flatMap((entries) =>
      Effect.reduce(entries, { exact: [], patterns: [] }, appendCorsEntry),
    ),
  );

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
    Option.map(
      yield* Config.option(Config.redacted("ENCRYPTION_MASTER_SECRET")),
      Redacted.value,
    ),
  );

  const port = yield* Config.integer("PORT").pipe(
    Config.withDefault(DEFAULT_SERVER_PORT),
  );
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
}).pipe(Effect.withSpan("ServerConfigLoader"));
