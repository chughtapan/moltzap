/**
 * @file Canonical server config. The only file in the package that knows
 * about YAML, env vars, or config file paths.
 *
 * Two public types:
 *   - `CoreConfig` — the programmatic input to `createCoreApp(...)`.
 *     Live instances (Db, WebhookClient, SpanProcessor) sit here.
 *   - `StandaloneBootPlan` — the flat output of `loadStandaloneConfig`.
 *     What `standalone.ts` reads after parsing YAML + env.
 *
 * One public function: `loadStandaloneConfig({configPath?})`.
 *
 * The internal YAML shape (`YamlConfig`) is not exported — operators
 * write YAML, but no consumer references its TS type. Everything flows
 * through the two public types above.
 */

import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { parse as parseYaml } from "yaml";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Either,
  Match,
  Option,
  Redacted,
  Schema,
} from "effect";
import type { ConfigError } from "effect/ConfigError";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Db } from "./db/client.js";
import type { SessionValidator } from "./identity/services/session-validator.js";
import type { WebhookClient } from "./adapters/webhook.js";

// ─────────────────────────────────────────────────────────────────────
// Public: CoreConfig — `createCoreApp` boot input
// ─────────────────────────────────────────────────────────────────────

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
   * offline recipient agent IDs. Body is signed with HMAC-SHA256 in the
   * `X-MoltZap-Signature: sha256=&lt;hex>` header using `secret`.
   */
  deliveryWebhook?: { url: string; secret: string };

  /**
   * Optional OpenTelemetry span processor. Tests pass
   * `SimpleSpanProcessor(InMemorySpanExporter)`; production deployments
   * leave unset and rely on `OTEL_EXPORTER_OTLP_ENDPOINT` env var (the
   * server builds a `BatchSpanProcessor(OTLPTraceExporter)` when set).
   */
  spanProcessor?: SpanProcessor;
}

// ─────────────────────────────────────────────────────────────────────
// Public: StandaloneBootPlan — `loadStandaloneConfig` output
// ─────────────────────────────────────────────────────────────────────

interface WebhookServiceBinding {
  readonly url: string;
  readonly timeoutMs: number | undefined;
}

export interface StandaloneBootPlan {
  /** DATABASE_URL or YAML `database.url`. Empty string → embedded PGlite. */
  readonly databaseUrl: string;
  /** YAML `database.data_dir` for PGlite (ignored when `databaseUrl` is set). */
  readonly pgliteDataDir: string | undefined;

  readonly encryptionMasterSecret: string | undefined;
  readonly port: number;
  readonly corsOrigins: string[];

  readonly devMode: boolean;
  /** True when YAML `dev_mode.enabled: true` — drives `devModeUserId` minting. */
  readonly devModeEnabled: boolean;
  /** YAML `dev_mode.user_id`. When `devModeEnabled` and this is undefined, callers mint a random UUID. */
  readonly devModeUserId: string | undefined;

  readonly registrationSecret: string | undefined;

  /** YAML `services.sessions: { type: "webhook" }` — drives `WebhookSessionValidator` wiring. */
  readonly sessionWebhook: WebhookServiceBinding | undefined;
  /** YAML `services.contacts: { type: "webhook" }` — drives `WebhookContactService` wiring. */
  readonly contactWebhook: WebhookServiceBinding | undefined;

  /** YAML `apps[]` — manifests to auto-register at boot. */
  readonly apps: ReadonlyArray<{ readonly manifest: string }>;

  /** Directory of the loaded YAML file (for resolving relative app manifest paths). */
  readonly configDirectory: string;
}

// ─────────────────────────────────────────────────────────────────────
// Public: ConfigLoadError
// ─────────────────────────────────────────────────────────────────────

export type ConfigLoadErrorKind = "read" | "yaml" | "env" | "validation";

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly kind: ConfigLoadErrorKind;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly configError?: ConfigError;
}> {}

// ─────────────────────────────────────────────────────────────────────
// Private: YAML schema (Effect Config descriptions)
// ─────────────────────────────────────────────────────────────────────

const MAX_PORT_NUMBER = 65_535;

const nonEmptyString = (name: string) =>
  Config.string(name).pipe(
    Config.validate({
      message: `${name} must be a non-empty string`,
      validation: (s: string) => s.length > 0,
    }),
  );

const portNumber = (name: string) =>
  Config.integer(name).pipe(
    Config.validate({
      message: `${name} must be in range [1, ${MAX_PORT_NUMBER}]`,
      validation: (n: number) => n >= 1 && n <= MAX_PORT_NUMBER,
    }),
  );

const opt = <A>(c: Config.Config<A>) =>
  c.pipe(Config.option, Config.map(Option.getOrUndefined));

interface YamlWebhookService {
  readonly type: "webhook";
  readonly webhook_url: string;
  readonly timeout_ms?: number;
  readonly callback_token?: string;
}

interface YamlInProcessService {
  readonly type: "in_process";
}

type YamlServiceConfig = YamlWebhookService | YamlInProcessService;

const YamlWebhookServiceConfig: Config.Config<YamlWebhookService> = Config.all({
  type: Config.literal("webhook")("type"),
  webhook_url: nonEmptyString("webhook_url"),
  timeout_ms: opt(Config.integer("timeout_ms")),
  callback_token: opt(nonEmptyString("callback_token")),
}).pipe(
  Config.map(
    ({ type, webhook_url, timeout_ms, callback_token }): YamlWebhookService => {
      const out: YamlWebhookService = { type, webhook_url };
      if (timeout_ms !== undefined) return { ...out, timeout_ms };
      if (callback_token !== undefined) return { ...out, callback_token };
      return out;
    },
  ),
);

const YamlInProcessServiceConfig: Config.Config<YamlInProcessService> =
  Config.all({ type: Config.literal("in_process")("type") }).pipe(
    Config.map(({ type }): YamlInProcessService => ({ type })),
  );

const YamlServiceBlock: Config.Config<YamlServiceConfig> =
  YamlWebhookServiceConfig.pipe(
    Config.orElse(() => YamlInProcessServiceConfig),
  );

interface YamlConfig {
  readonly server?: {
    readonly port?: number;
    readonly cors_origins?: string[];
  };
  readonly database?: { readonly url?: string; readonly data_dir?: string };
  readonly encryption?: { readonly master_secret?: string };
  readonly services?: {
    readonly sessions?: YamlServiceConfig;
    readonly contacts?: YamlServiceConfig;
  };
  readonly registration?: { readonly secret?: string };
  readonly dev_mode?: { readonly enabled: boolean; readonly user_id?: string };
  readonly apps?: ReadonlyArray<{ readonly manifest: string }>;
}

const YamlConfigSchema: Config.Config<YamlConfig> = Config.all({
  server: opt(
    Config.all({
      port: opt(portNumber("port")),
      cors_origins: opt(Config.array(Config.string(), "cors_origins")),
    }).pipe(Config.nested("server")),
  ),
  database: opt(
    Config.all({
      url: opt(nonEmptyString("url")),
      data_dir: opt(Config.string("data_dir")),
    }).pipe(Config.nested("database")),
  ),
  encryption: opt(
    Config.all({
      master_secret: opt(nonEmptyString("master_secret")),
    }).pipe(Config.nested("encryption")),
  ),
  services: opt(
    Config.all({
      sessions: opt(YamlServiceBlock.pipe(Config.nested("sessions"))),
      contacts: opt(YamlServiceBlock.pipe(Config.nested("contacts"))),
    }).pipe(Config.nested("services")),
  ),
  registration: opt(
    Config.all({ secret: opt(nonEmptyString("secret")) }).pipe(
      Config.nested("registration"),
    ),
  ),
  dev_mode: opt(
    Config.all({
      enabled: Config.boolean("enabled"),
      user_id: opt(nonEmptyString("user_id")),
    }).pipe(Config.nested("dev_mode")),
  ),
  apps: opt(
    Config.array(Config.all({ manifest: nonEmptyString("manifest") }), "apps"),
  ),
});

// ─────────────────────────────────────────────────────────────────────
// Internal: YAML file loader pipeline
// ─────────────────────────────────────────────────────────────────────

type ProcessEnvSnapshot = Readonly<Record<string, string | undefined>>;

const YamlDocumentSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
const decodeYamlDocument = Schema.decodeUnknownEither(YamlDocumentSchema);

function readEnvValue(
  processEnv: ProcessEnvSnapshot | undefined,
  key: string,
): string | undefined {
  if (processEnv !== undefined) return processEnv[key];
  return Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(key)).pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
}

function resolveConfigPath(
  path: string | undefined,
  processEnv: ProcessEnvSnapshot | undefined,
): string {
  return path ?? readEnvValue(processEnv, "MOLTZAP_CONFIG") ?? "moltzap.yaml";
}

function readConfigFile(
  configPath: string,
): Effect.Effect<string, ConfigLoadError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(configPath, "utf-8")),
    Effect.catchTags({
      BadArgument: (cause) =>
        Effect.fail(
          new ConfigLoadError({
            kind: "read",
            path: configPath,
            message: `Cannot read config file "${configPath}": ${cause.message}`,
            cause,
          }),
        ),
      SystemError: (cause) =>
        Effect.fail(
          new ConfigLoadError({
            kind: "read",
            path: configPath,
            message: `Cannot read config file "${configPath}": ${cause.message}`,
            cause,
          }),
        ),
    }),
  );
}

function parseYamlDocument(
  raw: string,
  configPath: string,
): Effect.Effect<unknown, ConfigLoadError> {
  return Effect.try({
    try: (): unknown => parseYaml(raw),
    catch: (cause) =>
      new ConfigLoadError({
        kind: "yaml",
        path: configPath,
        message: `Invalid YAML in "${configPath}": ${(cause as Error).message}`,
        cause,
      }),
  });
}

function decodeYamlMapping(
  parsed: unknown,
  configPath: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ConfigLoadError> {
  return Either.match(decodeYamlDocument(parsed), {
    onLeft: (cause) =>
      Effect.fail(
        new ConfigLoadError({
          kind: "yaml",
          path: configPath,
          message: `Invalid YAML in "${configPath}": top-level value must be a mapping (${cause.message})`,
          cause,
        }),
      ),
    onRight: (value) => Effect.succeed(value),
  });
}

function interpolateEnvVars(
  obj: unknown,
  path: string,
  processEnv?: ProcessEnvSnapshot,
): Effect.Effect<unknown, ConfigLoadError> {
  if (typeof obj === "string") {
    let missing: string | null = null;
    const replaced = obj.replace(
      /\$\{([^}]+)\}/g,
      (_match, varName: string) => {
        const value = readEnvValue(processEnv, varName);
        if (value === undefined || value === "") {
          if (missing === null) missing = varName;
          return "";
        }
        return value;
      },
    );
    if (missing !== null) {
      return Effect.fail(
        new ConfigLoadError({
          kind: "env",
          path,
          message: `Missing env var "${missing}" referenced in "${path}"`,
        }),
      );
    }
    return Effect.succeed(replaced);
  }
  if (Array.isArray(obj)) {
    return Effect.gen(function* () {
      const out: unknown[] = [];
      for (const value of obj) {
        out.push(yield* interpolateEnvVars(value, path, processEnv));
      }
      return out;
    });
  }
  if (obj !== null && typeof obj === "object") {
    return Effect.gen(function* () {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        out[key] = yield* interpolateEnvVars(value, path, processEnv);
      }
      return out;
    });
  }
  return Effect.succeed(obj);
}

function decodeYaml(
  raw: unknown,
  configPath: string,
): Effect.Effect<YamlConfig, ConfigLoadError> {
  return YamlConfigSchema.pipe(
    Effect.withConfigProvider(ConfigProvider.fromJson(raw ?? {})),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (configError) =>
          Effect.fail(
            new ConfigLoadError({
              kind: "validation",
              path: configPath,
              message: `Invalid config in "${configPath}": ${formatConfigError(configError)}`,
              configError,
            }),
          ),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );
}

function resolveConfigDir(
  configPath: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.realPath(configPath).pipe(
      Effect.map((real) => path.dirname(real)),
      Effect.catchAll((cause) =>
        Effect.logWarning("Failed to resolve config path symlink:", cause).pipe(
          Effect.as(path.dirname(configPath)),
        ),
      ),
    );
  });
}

function formatConfigError(err: ConfigError): string {
  const lines: string[] = [];
  const pushLeaf = (e: { path: ReadonlyArray<string>; message: string }) => {
    lines.push(`  ${e.path.join(".") || "/"}: ${e.message}`);
  };
  const walk = (e: ConfigError): void =>
    Match.value(e).pipe(
      Match.discriminatorsExhaustive("_op")({
        And: (and) => {
          walk(and.left);
          walk(and.right);
        },
        Or: (or) => {
          walk(or.left);
          walk(or.right);
        },
        InvalidData: pushLeaf,
        MissingData: pushLeaf,
        Unsupported: pushLeaf,
        SourceUnavailable: pushLeaf,
      }),
    );
  walk(err);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return "\n" + out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Env reading + StandaloneBootPlan build
// ─────────────────────────────────────────────────────────────────────

const TRUE_BOOLEAN_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_BOOLEAN_VALUES = new Set(["false", "0", "no", "off"]);
const DEFAULT_SERVER_PORT = 3000;
const DECIMAL_RADIX = 10;

function parseBoolEnv(
  raw: string | undefined,
  fallback: boolean,
): boolean | null {
  if (raw === undefined || raw.length === 0) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false;
  return null;
}

function parseIntEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.length === 0) return null;
  if (!/^-?\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw, DECIMAL_RADIX);
}

function parseCorsOriginsRaw(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadProcessEnvSnapshot(): Effect.Effect<ProcessEnvSnapshot, never> {
  // ENCRYPTION_MASTER_SECRET reads as Redacted; we unwrap into the snapshot
  // immediately, but the Effect log/error path that fired during config-read
  // never sees the raw value because Redacted intercepts string coercion.
  return Config.all({
    CORS_ORIGINS: opt(Config.string("CORS_ORIGINS")),
    DATABASE_URL: opt(Config.string("DATABASE_URL")),
    ENCRYPTION_MASTER_SECRET: opt(
      Config.redacted("ENCRYPTION_MASTER_SECRET"),
    ).pipe(
      Config.map((r) => (r === undefined ? undefined : Redacted.value(r))),
    ),
    MOLTZAP_CONFIG: opt(Config.string("MOLTZAP_CONFIG")),
    MOLTZAP_DEV_MODE: opt(Config.string("MOLTZAP_DEV_MODE")),
    PORT: opt(Config.string("PORT")),
  }).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.orElseSucceed(() => ({})),
  );
}

function webhookBinding(
  service: YamlServiceConfig | undefined,
): WebhookServiceBinding | undefined {
  if (service === undefined || service.type !== "webhook") return undefined;
  return { url: service.webhook_url, timeoutMs: service.timeout_ms };
}

function makeInvalidEnvError(
  configPath: string,
  message: string,
): ConfigLoadError {
  return new ConfigLoadError({
    kind: "env",
    path: configPath,
    message,
  });
}

interface BootPlanInputs {
  readonly yaml: YamlConfig;
  readonly configDirectory: string;
  readonly processEnv: ProcessEnvSnapshot;
  readonly configPath: string;
}

function resolveDevMode(
  processEnv: ProcessEnvSnapshot,
  yaml: YamlConfig,
  configPath: string,
): Effect.Effect<boolean, ConfigLoadError> {
  const value = parseBoolEnv(
    processEnv["MOLTZAP_DEV_MODE"],
    yaml.dev_mode?.enabled ?? false,
  );
  if (value === null) {
    return Effect.fail(
      makeInvalidEnvError(
        configPath,
        `MOLTZAP_DEV_MODE must be a boolean (true/false/1/0); received "${processEnv["MOLTZAP_DEV_MODE"]}"`,
      ),
    );
  }
  return Effect.succeed(value);
}

function resolvePort(
  processEnv: ProcessEnvSnapshot,
  yaml: YamlConfig,
  configPath: string,
): Effect.Effect<number, ConfigLoadError> {
  const raw = processEnv["PORT"] ?? String(yaml.server?.port ?? "");
  if (raw === "") return Effect.succeed(DEFAULT_SERVER_PORT);
  const value = parseIntEnv(raw);
  if (value === null) {
    return Effect.fail(
      makeInvalidEnvError(
        configPath,
        `PORT must be an integer; received "${raw}"`,
      ),
    );
  }
  return Effect.succeed(value);
}

function resolveCorsOrigins(
  processEnv: ProcessEnvSnapshot,
  yaml: YamlConfig,
  devMode: boolean,
  configPath: string,
): Effect.Effect<string[], ConfigLoadError> {
  const raw =
    processEnv["CORS_ORIGINS"] ?? yaml.server?.cors_origins?.join(",");
  const parsed = parseCorsOriginsRaw(raw);
  if (parsed.length > 0) return Effect.succeed(parsed);
  if (devMode) return Effect.succeed(["*"]);
  return Effect.fail(
    makeInvalidEnvError(
      configPath,
      "CORS_ORIGINS is required in production. Set to comma-separated origins, or enable dev mode.",
    ),
  );
}

function resolveDatabaseUrl(
  processEnv: ProcessEnvSnapshot,
  yaml: YamlConfig,
  devMode: boolean,
  configPath: string,
): Effect.Effect<string, ConfigLoadError> {
  const url = processEnv["DATABASE_URL"] ?? yaml.database?.url ?? "";
  if (devMode && url.includes(".supabase.co")) {
    return Effect.fail(
      makeInvalidEnvError(
        configPath,
        "MOLTZAP_DEV_MODE=true cannot be used with a Supabase-hosted database",
      ),
    );
  }
  return Effect.succeed(url);
}

interface ResolvedFields {
  readonly devMode: boolean;
  readonly port: number;
  readonly corsOrigins: string[];
  readonly databaseUrl: string;
}

interface YamlDerived {
  readonly pgliteDataDir: string | undefined;
  readonly encryptionFromYaml: string | undefined;
  readonly devMode: { enabled: boolean; userId: string | undefined };
  readonly registrationSecret: string | undefined;
  readonly sessionWebhook: WebhookServiceBinding | undefined;
  readonly contactWebhook: WebhookServiceBinding | undefined;
  readonly apps: ReadonlyArray<{ readonly manifest: string }>;
}

function projectYamlDevMode(yaml: YamlConfig): {
  enabled: boolean;
  userId: string | undefined;
} {
  const dev = yaml.dev_mode;
  return { enabled: dev?.enabled ?? false, userId: dev?.user_id };
}

function projectYaml(yaml: YamlConfig): YamlDerived {
  return {
    pgliteDataDir: yaml.database?.data_dir,
    encryptionFromYaml: yaml.encryption?.master_secret,
    devMode: projectYamlDevMode(yaml),
    registrationSecret: yaml.registration?.secret,
    sessionWebhook: webhookBinding(yaml.services?.sessions),
    contactWebhook: webhookBinding(yaml.services?.contacts),
    apps: yaml.apps ?? [],
  };
}

function assembleBootPlan(
  inputs: BootPlanInputs,
  fields: ResolvedFields,
): StandaloneBootPlan {
  const ymlDerived = projectYaml(inputs.yaml);
  return {
    databaseUrl: fields.databaseUrl,
    pgliteDataDir: ymlDerived.pgliteDataDir,
    encryptionMasterSecret:
      inputs.processEnv["ENCRYPTION_MASTER_SECRET"] ??
      ymlDerived.encryptionFromYaml,
    port: fields.port,
    corsOrigins: fields.corsOrigins,
    devMode: fields.devMode,
    devModeEnabled: ymlDerived.devMode.enabled,
    devModeUserId: ymlDerived.devMode.userId,
    registrationSecret: ymlDerived.registrationSecret,
    sessionWebhook: ymlDerived.sessionWebhook,
    contactWebhook: ymlDerived.contactWebhook,
    apps: ymlDerived.apps,
    configDirectory: inputs.configDirectory,
  };
}

function buildBootPlan(
  inputs: BootPlanInputs,
): Effect.Effect<StandaloneBootPlan, ConfigLoadError> {
  return Effect.gen(function* () {
    const { yaml, processEnv, configPath } = inputs;
    const devMode = yield* resolveDevMode(processEnv, yaml, configPath);
    const port = yield* resolvePort(processEnv, yaml, configPath);
    const corsOrigins = yield* resolveCorsOrigins(
      processEnv,
      yaml,
      devMode,
      configPath,
    );
    const databaseUrl = yield* resolveDatabaseUrl(
      processEnv,
      yaml,
      devMode,
      configPath,
    );
    return assembleBootPlan(inputs, {
      devMode,
      port,
      corsOrigins,
      databaseUrl,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Public: the single loader
// ─────────────────────────────────────────────────────────────────────

export interface LoadStandaloneConfigInput {
  /** Path to the YAML config file. Falls back to `MOLTZAP_CONFIG` env or `moltzap.yaml`. Missing file is tolerated as empty config UNLESS the path is explicit. */
  readonly configPath?: string;
  /** Override env reads (tests). Production omits — env comes from `process.env`. */
  readonly processEnv?: ProcessEnvSnapshot;
}

const EMPTY_YAML: YamlConfig = {};

export function loadStandaloneConfig(
  input: LoadStandaloneConfigInput = {},
): Effect.Effect<StandaloneBootPlan, ConfigLoadError> {
  return Effect.gen(function* () {
    const processEnv = input.processEnv ?? (yield* loadProcessEnvSnapshot());
    const explicit =
      input.configPath !== undefined ||
      processEnv["MOLTZAP_CONFIG"] !== undefined;
    const configPath = resolveConfigPath(input.configPath, processEnv);

    const { yaml, configDirectory } = yield* loadYamlFromDisk(
      configPath,
      processEnv,
      explicit,
    ).pipe(Effect.provide(NodeContext.layer));

    return yield* buildBootPlan({
      yaml,
      configDirectory,
      processEnv,
      configPath,
    });
  }).pipe(Effect.withSpan("loadStandaloneConfig"));
}

function loadYamlFromDisk(
  configPath: string,
  processEnv: ProcessEnvSnapshot,
  explicit: boolean,
): Effect.Effect<
  { yaml: YamlConfig; configDirectory: string },
  ConfigLoadError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const raw = yield* readConfigFile(configPath).pipe(
      Effect.catchTag("ConfigLoadError", (error) => {
        if (error.kind === "read" && !explicit) {
          return Effect.succeed(null);
        }
        return Effect.fail(error);
      }),
    );
    if (raw === null) {
      return { yaml: EMPTY_YAML, configDirectory: globalThis.process.cwd() };
    }
    const parsed = yield* parseYamlDocument(raw, configPath);
    const decoded = yield* decodeYamlMapping(parsed, configPath);
    const interpolated = yield* interpolateEnvVars(
      decoded,
      configPath,
      processEnv,
    );
    const yaml = yield* decodeYaml(interpolated, configPath);
    const configDirectory = yield* resolveConfigDir(configPath);
    return { yaml, configDirectory };
  });
}
