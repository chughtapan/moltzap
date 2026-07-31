/**
 * @file Canonical server config. The only file in the package that knows
 * about YAML, env vars, or config file paths.
 *
 * Two public types:
 *   - `CoreConfig` — the programmatic input to `createCoreApp(...)`.
 *     Live instances (Db, SpanProcessor) sit here.
 *   - `StandaloneBootPlan` — the flat output of `loadStandaloneConfig`.
 *     What `standalone.ts` reads after parsing YAML + env.
 *
 * One public function: `loadStandaloneConfig({configPath?, processEnv?})`.
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
  Option,
  Redacted,
  Schema,
} from "effect";
import { TreeFormatter } from "effect/ParseResult";
import {
  RegistrationSecret,
  ServerEncryptionMasterSecret,
} from "#config/secrets";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { UserId } from "@moltzap/protocol/identity";
import type { Db } from "#db";

// ─────────────────────────────────────────────────────────────────────
// Public: CoreConfig — `createCoreApp` boot input
// ─────────────────────────────────────────────────────────────────────

export interface CoreConfig {
  db: Db;
  dbCleanup?: () => PromiseLike<void>;
  encryptionMasterSecret?: ServerEncryptionMasterSecret;
  port: number;
  corsOrigins: string[];
  registrationSecret?: RegistrationSecret;
  devMode?: boolean;

  /**
   * Boot-time admin owner id. Agents registered through the default
   * `/api/v1/auth/register` route are owned by this user until the
   * full app-specific registration/contact flow is installed.
   */
  adminUserId: UserId;

  /**
   * When true, core does not mount its default `/api/v1/auth/register`
   * route. Apps that want their own invite-gated / rate-limited register
   * flow set this and mount their own handler.
   */
  skipDefaultRegisterRoute?: boolean;

  /**
   * Optional OpenTelemetry span processor. Tests typically pass
   * `new SimpleSpanProcessor(new InMemorySpanExporter())` so they can
   * read finished spans via the exporter; production deployments
   * usually leave this unset and rely on `OTEL_EXPORTER_OTLP_ENDPOINT`
   * env var (the server builds a `BatchSpanProcessor(OTLPTraceExporter)`
   * when set). When neither is provided, spans live in Effect's fiber
   * context but are not exported.
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

  readonly encryptionMasterSecret: ServerEncryptionMasterSecret | undefined;
  readonly port: number;
  readonly corsOrigins: string[];

  readonly devMode: boolean;
  /** Boot-time admin owner id from `MOLTZAP_ADMIN_USER_ID` or YAML `admin_user_id`. */
  readonly adminUserId: UserId;

  readonly registrationSecret: RegistrationSecret | undefined;

  /** YAML `services.contacts: { type: "webhook" }` — drives `WebhookContactService` wiring. */
  readonly contactWebhook: WebhookServiceBinding | undefined;

  /** YAML `apps[]` — manifest references carried through from the config file. */
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
}> {}

// ─────────────────────────────────────────────────────────────────────
// Private: YAML schema — the single source of truth for the file shape
//
// `Schema.decodeUnknownEither` with `onExcessProperty: "error"` rejects
// unknown keys and requires `master_secret`, so a camelCase typo
// (`masterSecret`) or `encryption: {}` cannot pass and silently disable
// at-rest encryption (plaintext storage). The same decode pins the port
// range, the webhook URI, the `timeout_ms` floor, and every `minLength`
// rule, and produces the typed `YamlConfig` value
// the boot-plan build reads — one pass for both validation and shape.
// ─────────────────────────────────────────────────────────────────────

const MAX_PORT_NUMBER = 65_535;

function opt<A>(c: Config.Config<A>) {
  return c.pipe(Config.option, Config.map(Option.getOrUndefined));
}

// `URL.canParse` requires an absolute URI (a scheme present), so
// `not-a-url` is rejected while `https://hooks.example.com/x` passes.
const UriString = Schema.String.pipe(
  Schema.filter((s) => URL.canParse(s) || "must be a valid absolute URI"),
);

const PortNumber = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_PORT_NUMBER),
);

const WebhookServiceShape = Schema.Struct({
  type: Schema.Literal("webhook"),
  webhook_url: UriString,
  timeout_ms: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(100)),
  ),
  callback_token: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
});

const InProcessServiceShape = Schema.Struct({
  type: Schema.Literal("in_process"),
});

const ServiceShape = Schema.Union(WebhookServiceShape, InProcessServiceShape);

const AppRefShape = Schema.Struct({
  manifest: Schema.String.pipe(Schema.minLength(1)),
});

const MoltZapConfigShape = Schema.Struct({
  admin_user_id: Schema.optional(UserId),
  server: Schema.optional(
    Schema.Struct({
      port: Schema.optional(PortNumber),
      cors_origins: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  database: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
      data_dir: Schema.optional(Schema.String),
    }),
  ),
  encryption: Schema.optional(
    Schema.Struct({ master_secret: ServerEncryptionMasterSecret }),
  ),
  services: Schema.optional(
    Schema.Struct({ contacts: Schema.optional(ServiceShape) }),
  ),
  registration: Schema.optional(
    Schema.Struct({ secret: Schema.optional(RegistrationSecret) }),
  ),
  dev_mode: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
    }),
  ),
  apps: Schema.optional(Schema.Array(AppRefShape)),
});

type YamlConfig = Schema.Schema.Type<typeof MoltZapConfigShape>;
type YamlServiceConfig = Schema.Schema.Type<typeof ServiceShape>;

const decodeConfigShape = Schema.decodeUnknownEither(MoltZapConfigShape, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Decode the interpolated YAML into the typed `YamlConfig`. Surfaces the
 * full `ParseError` tree (path + message per leaf) as a single
 * `ConfigLoadError`.
 */
function decodeYamlShape(
  value: unknown,
  configPath: string,
): Effect.Effect<YamlConfig, ConfigLoadError> {
  return Either.match(decodeConfigShape(value), {
    onLeft: (error) =>
      Effect.fail(
        new ConfigLoadError({
          kind: "validation",
          path: configPath,
          message: `Invalid config in "${configPath}":\n${TreeFormatter.formatErrorSync(error)}`,
        }),
      ),
    onRight: (yaml) => Effect.succeed(yaml),
  }).pipe(Effect.withSpan("decodeYamlShape"));
}

// ─────────────────────────────────────────────────────────────────────
// Internal: YAML file loader pipeline
// ─────────────────────────────────────────────────────────────────────

type ProcessEnvSnapshot = Readonly<Record<string, string | undefined>>;

/**
 * Top-level YAML document shape. A scalar, array, or `null` at the top
 * level is not a config mapping. Decoding it here — before env
 * interpolation — fails loudly with one clear "must be a mapping"
 * message instead of a confusing per-key validation error downstream.
 */
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
    Effect.withSpan("readConfigFile"),
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
  }).pipe(Effect.withSpan("parseYamlDocument"));
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
  }).pipe(Effect.withSpan("decodeYamlMapping"));
}

/** Interpolate `${ENV_VAR}` references in string values throughout a parsed object. */
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
        // Treat empty string the same as undefined: an accidentally empty
        // env var would otherwise silently interpolate into strings like
        // `https://${HOST}/callback` and produce a broken URL that still
        // passes the outer key's minLength check.
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
  }).pipe(Effect.withSpan("resolveConfigDir"));
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
  return Config.all({
    CORS_ORIGINS: opt(Config.string("CORS_ORIGINS")),
    DATABASE_URL: opt(Config.string("DATABASE_URL")),
    MOLTZAP_ADMIN_USER_ID: opt(Config.string("MOLTZAP_ADMIN_USER_ID")),
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
  readonly encryptionMasterSecretFromEnv:
    | ServerEncryptionMasterSecret
    | undefined;
}

function decodeEnvSecret<A, I>(
  schema: Schema.Schema<A, I>,
  value: string | undefined,
  envKey: string,
  configPath: string,
): Effect.Effect<A | undefined, ConfigLoadError> {
  if (value === undefined || value.length === 0) {
    return Effect.succeed(undefined);
  }
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) =>
      makeInvalidEnvError(
        configPath,
        `${envKey} is invalid: ${TreeFormatter.formatErrorSync(cause)}`,
      ),
    ),
  );
}

function loadEncryptionMasterSecretFromEnv(
  configPath: string,
): Effect.Effect<ServerEncryptionMasterSecret | undefined, ConfigLoadError> {
  return Config.option(Config.redacted("ENCRYPTION_MASTER_SECRET")).pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.mapError((cause) =>
      makeInvalidEnvError(
        configPath,
        `ENCRYPTION_MASTER_SECRET is invalid: ${String(cause)}`,
      ),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(undefined),
        onSome: (secret) =>
          decodeEnvSecret(
            ServerEncryptionMasterSecret,
            Redacted.value(secret),
            "ENCRYPTION_MASTER_SECRET",
            configPath,
          ),
      }),
    ),
  );
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

function resolveAdminUserId(
  processEnv: ProcessEnvSnapshot,
  yaml: YamlConfig,
  configPath: string,
): Effect.Effect<UserId, ConfigLoadError> {
  const raw = processEnv["MOLTZAP_ADMIN_USER_ID"];
  if (raw !== undefined && raw.length > 0) {
    return Either.match(Schema.decodeUnknownEither(UserId)(raw), {
      onLeft: (cause) =>
        Effect.fail(
          makeInvalidEnvError(
            configPath,
            `MOLTZAP_ADMIN_USER_ID must be a UUID (${cause.message})`,
          ),
        ),
      onRight: Effect.succeed,
    });
  }
  if (yaml.admin_user_id !== undefined)
    return Effect.succeed(yaml.admin_user_id);
  return Effect.fail(
    makeInvalidEnvError(
      configPath,
      "admin_user_id is required. Set YAML admin_user_id or MOLTZAP_ADMIN_USER_ID.",
    ),
  );
}

interface ResolvedFields {
  readonly devMode: boolean;
  readonly port: number;
  readonly corsOrigins: string[];
  readonly databaseUrl: string;
  readonly adminUserId: UserId;
}

interface YamlDerived {
  readonly pgliteDataDir: string | undefined;
  readonly encryptionFromYaml: ServerEncryptionMasterSecret | undefined;
  readonly registrationSecret: RegistrationSecret | undefined;
  readonly contactWebhook: WebhookServiceBinding | undefined;
  readonly apps: ReadonlyArray<{ readonly manifest: string }>;
}

function projectYaml(yaml: YamlConfig): YamlDerived {
  return {
    pgliteDataDir: yaml.database?.data_dir,
    encryptionFromYaml: yaml.encryption?.master_secret,
    registrationSecret: yaml.registration?.secret,
    contactWebhook: webhookBinding(yaml.services?.contacts),
    apps: yaml.apps ?? [],
  };
}

function assembleBootPlan(
  inputs: BootPlanInputs,
  fields: ResolvedFields,
  encryptionFromEnv: ServerEncryptionMasterSecret | undefined,
): StandaloneBootPlan {
  const ymlDerived = projectYaml(inputs.yaml);
  return {
    databaseUrl: fields.databaseUrl,
    pgliteDataDir: ymlDerived.pgliteDataDir,
    encryptionMasterSecret: encryptionFromEnv ?? ymlDerived.encryptionFromYaml,
    port: fields.port,
    corsOrigins: fields.corsOrigins,
    devMode: fields.devMode,
    adminUserId: fields.adminUserId,
    registrationSecret: ymlDerived.registrationSecret,
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
    const adminUserId = yield* resolveAdminUserId(processEnv, yaml, configPath);
    return assembleBootPlan(
      inputs,
      {
        devMode,
        port,
        corsOrigins,
        databaseUrl,
        adminUserId,
      },
      inputs.encryptionMasterSecretFromEnv,
    );
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
    const encryptionMasterSecretFromEnv =
      input.processEnv === undefined
        ? yield* loadEncryptionMasterSecretFromEnv(configPath)
        : yield* decodeEnvSecret(
            ServerEncryptionMasterSecret,
            input.processEnv["ENCRYPTION_MASTER_SECRET"],
            "ENCRYPTION_MASTER_SECRET",
            configPath,
          );

    return yield* buildBootPlan({
      yaml,
      configDirectory,
      processEnv,
      configPath,
      encryptionMasterSecretFromEnv,
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
    const yaml = yield* decodeYamlShape(interpolated, configPath);
    const configDirectory = yield* resolveConfigDir(configPath);
    return { yaml, configDirectory };
  });
}
