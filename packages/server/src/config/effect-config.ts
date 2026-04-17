/**
 * Effect `Config` descriptions for the MoltZap YAML config.
 *
 * Each piece is a composable `Config<A>` built from `Config.primitive` leaves.
 * The resulting `MoltZapAppConfig` below produces the same runtime shape as
 * the legacy `MoltZapConfig` type from `schema.ts` — all nested sections that
 * were optional stay optional here via `Config.option` or `Config.withDefault`.
 *
 * Feed this with a YAML-derived `ConfigProvider.fromJson` at runtime
 * (see `loader.ts`). Failures surface as a structured `ConfigError` in the
 * Effect error channel rather than thrown exceptions.
 */

import { Config, Option } from "effect";

// ── Reusable leaves ────────────────────────────────────────────────────

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
      message: `${name} must be in range [1, 65535]`,
      validation: (n: number) => n >= 1 && n <= 65535,
    }),
  );

const opt = <A>(c: Config.Config<A>) =>
  c.pipe(Config.option, Config.map(Option.getOrUndefined));

// ── Service discriminated union (webhook | in_process) ────────────────

export interface WebhookService {
  type: "webhook";
  webhook_url: string;
  timeout_ms?: number;
  callback_token?: string;
}

export interface InProcessService {
  type: "in_process";
}

export type ServiceConfig = WebhookService | InProcessService;

const WebhookService: Config.Config<WebhookService> = Config.all({
  type: Config.literal("webhook")("type"),
  webhook_url: nonEmptyString("webhook_url"),
  timeout_ms: opt(Config.integer("timeout_ms")),
  callback_token: opt(nonEmptyString("callback_token")),
}).pipe(
  Config.map(
    ({ type, webhook_url, timeout_ms, callback_token }): WebhookService => {
      const out: WebhookService = { type, webhook_url };
      if (timeout_ms !== undefined) out.timeout_ms = timeout_ms;
      if (callback_token !== undefined) out.callback_token = callback_token;
      return out;
    },
  ),
);

const InProcessService: Config.Config<InProcessService> = Config.all({
  type: Config.literal("in_process")("type"),
}).pipe(Config.map(({ type }): InProcessService => ({ type })));

const ServiceBlock: Config.Config<ServiceConfig> = WebhookService.pipe(
  Config.orElse(() => InProcessService),
);

// ── Top-level sections ────────────────────────────────────────────────

const ServerSection = Config.all({
  port: opt(portNumber("port")),
  cors_origins: opt(Config.array(Config.string(), "cors_origins")),
});

const DatabaseSection = Config.all({
  url: opt(nonEmptyString("url")),
  data_dir: opt(Config.string("data_dir")),
});

const EncryptionSection = Config.all({
  master_secret: nonEmptyString("master_secret"),
});

const ServicesSection = Config.all({
  users: opt(ServiceBlock.pipe(Config.nested("users"))),
  contacts: opt(ServiceBlock.pipe(Config.nested("contacts"))),
  permissions: opt(ServiceBlock.pipe(Config.nested("permissions"))),
});

const RegistrationSection = Config.all({
  secret: opt(nonEmptyString("secret")),
});

const SeedAgentEntry = Config.all({
  name: nonEmptyString("name"),
  description: opt(Config.string("description")),
}).pipe(
  Config.map(({ name, description }) => {
    const out: { name: string; description?: string } = { name };
    if (description !== undefined) out.description = description;
    return out;
  }),
);

const SeedDemo = Config.all({
  topic: opt(Config.string("topic")),
  runtime: opt(Config.literal("openclaw", "nanoclaw")("runtime")),
  model: opt(Config.string("model")),
});

const SeedSection = Config.all({
  agents: opt(Config.array(SeedAgentEntry, "agents")),
  onboarding_message: opt(Config.string("onboarding_message")),
  demo: opt(SeedDemo.pipe(Config.nested("demo"))),
});

const AppRef = Config.all({
  manifest: nonEmptyString("manifest"),
});

// ── Top-level config ──────────────────────────────────────────────────

export interface MoltZapAppConfig {
  server?: { port?: number; cors_origins?: string[] };
  database?: { url?: string; data_dir?: string };
  encryption?: { master_secret: string };
  services?: {
    users?: ServiceConfig;
    contacts?: ServiceConfig;
    permissions?: ServiceConfig;
  };
  registration?: { secret?: string };
  seed?: {
    agents?: Array<{ name: string; description?: string }>;
    onboarding_message?: string;
    demo?: {
      topic?: string;
      runtime?: "openclaw" | "nanoclaw";
      model?: string;
    };
  };
  apps?: Array<{ manifest: string }>;
  log_level?: "debug" | "info" | "warn" | "error";
}

/**
 * The full MoltZap config as an Effect `Config`. Consume it by providing a
 * `ConfigProvider` (e.g. `ConfigProvider.fromJson(yamlObj)`) via
 * `Effect.withConfigProvider`.
 */
export const MoltZapConfig: Config.Config<MoltZapAppConfig> = Config.all({
  server: opt(ServerSection.pipe(Config.nested("server"))),
  database: opt(DatabaseSection.pipe(Config.nested("database"))),
  encryption: opt(EncryptionSection.pipe(Config.nested("encryption"))),
  services: opt(ServicesSection.pipe(Config.nested("services"))),
  registration: opt(RegistrationSection.pipe(Config.nested("registration"))),
  seed: opt(SeedSection.pipe(Config.nested("seed"))),
  apps: opt(Config.array(AppRef, "apps")),
  log_level: opt(Config.literal("debug", "info", "warn", "error")("log_level")),
}).pipe(
  Config.map((fields): MoltZapAppConfig => {
    const out: MoltZapAppConfig = {};
    if (fields.server !== undefined) out.server = fields.server;
    if (fields.database !== undefined) out.database = fields.database;
    if (fields.encryption !== undefined) out.encryption = fields.encryption;
    if (fields.services !== undefined) out.services = fields.services;
    if (fields.registration !== undefined)
      out.registration = fields.registration;
    if (fields.seed !== undefined) out.seed = fields.seed;
    if (fields.apps !== undefined) out.apps = fields.apps;
    if (fields.log_level !== undefined) out.log_level = fields.log_level;
    return out;
  }),
);
