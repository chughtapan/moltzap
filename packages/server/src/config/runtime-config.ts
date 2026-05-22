/**
 * Shared runtime process config for server boot and eval orchestration.
 *
 * Loads the YAML config (when present) and the env-driven `LoadedConfig`,
 * then combines them into a `RuntimeProcessConfig` that `standalone.ts`
 * consumes. OTel tracing (formerly modeled here as a dead config branch)
 * is wired separately via `app/tracing.ts` — it reads
 * `OTEL_EXPORTER_OTLP_ENDPOINT` directly when needed.
 */

import {
  Brand,
  Config,
  ConfigProvider,
  Data,
  Effect,
  Match,
  Option,
} from "effect";
import { NodeContext } from "@effect/platform-node";
import type { ConfigError } from "effect/ConfigError";
import type { LoadedConfig } from "../app/config.js";
import { ServerConfigLoader } from "../app/config.js";
import type { MoltZapAppConfig } from "./effect-config.js";
import { ConfigLoadError, loadConfigFromFile } from "./loader.js";

export type RuntimeConfigPath = string & Brand.Brand<"RuntimeConfigPath">;
const RuntimeConfigPathBrand = Brand.nominal<RuntimeConfigPath>();

export function runtimeConfigPath(path: string): RuntimeConfigPath {
  return RuntimeConfigPathBrand(path);
}

export interface LoadRuntimeConfigInput {
  readonly configPath?: RuntimeConfigPath;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeProcessConfig {
  readonly configDirectory: string;
  readonly app: MoltZapAppConfig;
  readonly server: LoadedConfig;
}

export class RuntimeConfigSurfaceError extends Data.TaggedError(
  "RuntimeConfigSurfaceError",
)<{
  readonly cause: RuntimeConfigSurfaceCause;
}> {}

class ConfigFileUnreadable extends Data.TaggedError("ConfigFileUnreadable")<{
  readonly message: string;
  readonly path: string;
}> {}

class ConfigFileInvalid extends Data.TaggedError("ConfigFileInvalid")<{
  readonly message: string;
  readonly path: string;
}> {}

class EnvironmentInvalid extends Data.TaggedError("EnvironmentInvalid")<{
  readonly key: string;
  readonly message: string;
}> {}

type RuntimeConfigSurfaceCause =
  | ConfigFileUnreadable
  | ConfigFileInvalid
  | EnvironmentInvalid;

type ProcessEnvSnapshot = Readonly<Record<string, string | undefined>>;

const DECIMAL_RADIX = 10;
const TRUE_BOOLEAN_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_BOOLEAN_VALUES = new Set(["false", "0", "no", "off"]);

const optionalEnv = (key: string) =>
  Config.option(Config.string(key)).pipe(Config.map(Option.getOrUndefined));

const RuntimeEnvSnapshotConfig = Config.all({
  CORS_ORIGINS: optionalEnv("CORS_ORIGINS"),
  DATABASE_URL: optionalEnv("DATABASE_URL"),
  ENCRYPTION_MASTER_SECRET: optionalEnv("ENCRYPTION_MASTER_SECRET"),
  MOLTZAP_CONFIG: optionalEnv("MOLTZAP_CONFIG"),
  MOLTZAP_DEV_MODE: optionalEnv("MOLTZAP_DEV_MODE"),
  PORT: optionalEnv("PORT"),
});

const loadRuntimeEnvSnapshot: Effect.Effect<ProcessEnvSnapshot, never> =
  RuntimeEnvSnapshotConfig.pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.orElseSucceed(() => ({})),
  );

const configFileUnreadable = (
  path: RuntimeConfigPath,
  message: string,
): RuntimeConfigSurfaceError =>
  new RuntimeConfigSurfaceError({
    cause: new ConfigFileUnreadable({ path, message }),
  });

const configFileInvalid = (
  path: RuntimeConfigPath,
  message: string,
): RuntimeConfigSurfaceError =>
  new RuntimeConfigSurfaceError({
    cause: new ConfigFileInvalid({ path, message }),
  });

const environmentInvalid = (
  key: string,
  message: string,
): RuntimeConfigSurfaceError =>
  new RuntimeConfigSurfaceError({
    cause: new EnvironmentInvalid({ key, message }),
  });

function resolveRuntimeConfigPath(
  input: LoadRuntimeConfigInput,
  processEnv: ProcessEnvSnapshot,
): RuntimeConfigPath {
  const selected =
    input.configPath ?? processEnv["MOLTZAP_CONFIG"] ?? "moltzap.yaml";
  return runtimeConfigPath(selected);
}

function mapConfigLoadError(
  configPath: RuntimeConfigPath,
  error: ConfigLoadError,
): RuntimeConfigSurfaceError {
  switch (error.kind) {
    case "read":
      return configFileUnreadable(configPath, error.message);
    case "env": {
      const missingKey = error.message.match(/"([^"]+)"/)?.[1] ?? "unknown";
      return environmentInvalid(missingKey, error.message);
    }
    case "yaml":
    case "validation":
      return configFileInvalid(configPath, error.message);
  }
}

function formatConfigError(error: ConfigError): string {
  const lines: string[] = [];
  const pushLeaf = (leaf: { path: ReadonlyArray<string>; message: string }) => {
    lines.push(`  ${leaf.path.join(".") || "/"}: ${leaf.message}`);
  };
  const walk = (current: ConfigError): void =>
    Match.value(current).pipe(
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
  walk(error);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      deduped.push(line);
    }
  }
  return "\n" + deduped.join("\n");
}

function parseBooleanEnv(
  raw: string | undefined,
  key: string,
  fallback: boolean,
): Effect.Effect<boolean, RuntimeConfigSurfaceError, never> {
  if (raw === undefined || raw.length === 0) {
    return Effect.succeed(fallback);
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return Effect.succeed(true);
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return Effect.succeed(false);
  return Effect.fail(
    environmentInvalid(
      key,
      `${key} must be a boolean-like value (true/false/1/0/yes/no/on/off); received "${raw}"`,
    ),
  );
}

function parseIntegerEnv(
  raw: string | undefined,
  key: string,
): Effect.Effect<number | undefined, RuntimeConfigSurfaceError, never> {
  if (raw === undefined || raw.length === 0) {
    return Effect.succeed(undefined);
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    return Effect.fail(
      environmentInvalid(key, `${key} must be an integer; received "${raw}"`),
    );
  }
  return Effect.succeed(Number.parseInt(raw, DECIMAL_RADIX));
}

function setProviderInputIfDefined(
  providerInput: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) providerInput[key] = value;
}

function applyAppConfigProviderInput(
  providerInput: Record<string, unknown>,
  appConfig: MoltZapAppConfig,
): void {
  setProviderInputIfDefined(
    providerInput,
    "DATABASE_URL",
    appConfig.database?.url,
  );
  setProviderInputIfDefined(
    providerInput,
    "ENCRYPTION_MASTER_SECRET",
    appConfig.encryption?.master_secret,
  );
  setProviderInputIfDefined(providerInput, "PORT", appConfig.server?.port);
  if (appConfig.server?.cors_origins !== undefined) {
    providerInput["CORS_ORIGINS"] = appConfig.server.cors_origins.join(",");
  }
  setProviderInputIfDefined(
    providerInput,
    "MOLTZAP_DEV_MODE",
    appConfig.dev_mode?.enabled,
  );
}

function applyProcessEnvProviderInput(
  providerInput: Record<string, unknown>,
  processEnv: ProcessEnvSnapshot,
): void {
  setProviderInputIfDefined(
    providerInput,
    "DATABASE_URL",
    processEnv["DATABASE_URL"],
  );
  setProviderInputIfDefined(
    providerInput,
    "ENCRYPTION_MASTER_SECRET",
    processEnv["ENCRYPTION_MASTER_SECRET"],
  );
  setProviderInputIfDefined(
    providerInput,
    "CORS_ORIGINS",
    processEnv["CORS_ORIGINS"],
  );
}

function buildServerConfigProviderInput(
  appConfig: MoltZapAppConfig,
  processEnv: ProcessEnvSnapshot,
): Effect.Effect<Record<string, unknown>, RuntimeConfigSurfaceError, never> {
  return Effect.gen(function* () {
    const providerInput: Record<string, unknown> = {};
    applyAppConfigProviderInput(providerInput, appConfig);
    applyProcessEnvProviderInput(providerInput, processEnv);

    const port = yield* parseIntegerEnv(processEnv["PORT"], "PORT");
    setProviderInputIfDefined(providerInput, "PORT", port);

    const devMode = yield* parseBooleanEnv(
      processEnv["MOLTZAP_DEV_MODE"],
      "MOLTZAP_DEV_MODE",
      appConfig.dev_mode?.enabled ?? false,
    );
    providerInput["MOLTZAP_DEV_MODE"] = devMode;

    return providerInput;
  }).pipe(Effect.withSpan("loadRuntimeProcessConfig"));
}

/** Empty app config used when no YAML file is found on the auto-discovery path. */
const EMPTY_APP_CONFIG: MoltZapAppConfig & { _configDir: string } = {
  _configDir: globalThis.process.cwd(),
};

type LoadedRuntimeAppConfig = MoltZapAppConfig & { _configDir: string };

function isExplicitConfigPath(
  input: LoadRuntimeConfigInput,
  processEnv: ProcessEnvSnapshot,
): boolean {
  return (
    input.configPath !== undefined || processEnv["MOLTZAP_CONFIG"] !== undefined
  );
}

function loadRuntimeAppConfig(
  configPath: RuntimeConfigPath,
  processEnv: ProcessEnvSnapshot,
  explicitConfigPath: boolean,
): Effect.Effect<LoadedRuntimeAppConfig, RuntimeConfigSurfaceError, never> {
  return loadConfigFromFile(configPath, processEnv).pipe(
    Effect.catchIf(
      (error): error is ConfigLoadError =>
        error instanceof ConfigLoadError &&
        error.kind === "read" &&
        !explicitConfigPath,
      () => Effect.succeed(EMPTY_APP_CONFIG),
    ),
    Effect.mapError((error) => mapConfigLoadError(configPath, error)),
    Effect.provide(NodeContext.layer),
  );
}

function stripConfigDir(
  loadedAppConfig: LoadedRuntimeAppConfig,
): MoltZapAppConfig {
  const app = { ...loadedAppConfig };
  delete (app as { _configDir?: string })._configDir;
  return app;
}

function loadServerConfig(
  configPath: RuntimeConfigPath,
  serverProviderInput: Record<string, unknown>,
): Effect.Effect<LoadedConfig, RuntimeConfigSurfaceError, never> {
  return ServerConfigLoader.pipe(
    Effect.withConfigProvider(ConfigProvider.fromJson(serverProviderInput)),
    Effect.mapError((configError) =>
      configFileInvalid(
        configPath,
        `Invalid runtime config in "${configPath}": ${formatConfigError(configError)}`,
      ),
    ),
  );
}

export function loadRuntimeProcessConfig(
  input: LoadRuntimeConfigInput,
): Effect.Effect<RuntimeProcessConfig, RuntimeConfigSurfaceError, never> {
  return Effect.gen(function* () {
    const processEnv = input.processEnv ?? (yield* loadRuntimeEnvSnapshot);
    const configPath = resolveRuntimeConfigPath(input, processEnv);
    const loadedAppConfig = yield* loadRuntimeAppConfig(
      configPath,
      processEnv,
      isExplicitConfigPath(input, processEnv),
    );
    const app = stripConfigDir(loadedAppConfig);
    const serverProviderInput = yield* buildServerConfigProviderInput(
      app,
      processEnv,
    );
    const server = yield* loadServerConfig(configPath, serverProviderInput);

    return {
      configDirectory: loadedAppConfig._configDir,
      app,
      server,
    };
  }).pipe(Effect.withSpan("loadRuntimeProcessConfig"));
}
