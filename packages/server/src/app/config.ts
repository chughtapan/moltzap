import {
  Config,
  ConfigError,
  Effect,
  Option,
  Redacted,
  type Layer,
} from "effect";
import type { Db } from "../db/client.js";
import type { SessionValidator } from "../identity/services/session-validator.js";
import type { WebhookClient } from "../adapters/webhook.js";
import type { TraceCaptureTag } from "../runtime-surface/trace-capture.js";

export interface CoreConfig {
  db: Db;
  dbCleanup?: () => PromiseLike<void>;
  encryptionMasterSecret?: string;
  port: number;
  corsOrigins: string[];
  registrationSecret?: string;
  devMode?: boolean;

  /**
   * When set, agents registered via the default `/api/v1/auth/register`
   * route are given this user id as their `owner_user_id`, skipping the
   * claim step. Intended for local dev / quickstart. Production MUST
   * leave this unset and perform claim through an external auth
   * provider (see docs/guides/custom-identity-provider.mdx).
   */
  devModeUserId?: string;

  /**
   * Optional bearer-token session validator (called from `network/connect`
   * when the caller authenticates with a `sessionToken`). Unset → bearer-
   * token auth is unsupported; only `agentKey` auth works.
   */
  sessionValidator?: SessionValidator;

  /**
   * Shared outbound HTTP client used for `MessageService.deliveryWebhook`
   * fanout and user-side adapters (contact/user services). If unset,
   * `createCoreApp` constructs a default `new WebhookClient()`. Tests may
   * inject a fake to intercept outbound HTTP.
   */
  webhookClient?: WebhookClient;

  /**
   * When true, core does not mount its default `/api/v1/auth/register`
   * route. Apps that want their own invite-gated / rate-limited register
   * flow set this and mount their own handler.
   */
  skipDefaultRegisterRoute?: boolean;

  /**
   * Fire-and-forget HTTP webhook after message delivery with the list of
   * offline recipient agent IDs. Use to drive push notifications or analytics
   * out of band. Body is signed with HMAC-SHA256 in the
   * `X-MoltZap-Signature: sha256=&lt;hex>` header using `secret`.
   *
   * Shape: `{ conversationId, messageId, offlineRecipientAgentIds: string[] }`.
   *
   * Dispatched on a detached daemon fiber with a 3-attempt exponential backoff
   * (1s base, jittered). Failures log and drop — never block `messages/send`.
   */
  deliveryWebhook?: { url: string; secret: string };

  /**
   * Optional trace-capture layer override. When unset, the server runs with
   * the default no-op capture and emits no trace artifacts.
   */
  traceCaptureLayer?: Layer.Layer<TraceCaptureTag>;
}

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
