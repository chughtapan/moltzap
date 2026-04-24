/**
 * Shared runtime process config for server boot and eval orchestration.
 */

import { ConfigProvider, Data, Effect, Match } from "effect";
import type { ConfigError } from "effect/ConfigError";
import type { LoadedConfig } from "../app/config.js";
import { ServerConfigLoader } from "../app/config.js";
import type { MoltZapAppConfig } from "../config/effect-config.js";
import { ConfigLoadError, loadConfigFromFile } from "../config/loader.js";

export type RuntimeConfigPath = string & {
  readonly __brand: "RuntimeConfigPath";
};

export type RuntimeEnvironment = "development" | "test" | "production";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeLoggingConfig {
  readonly level: RuntimeLogLevel;
  readonly preserveLegacyFields: boolean;
}

export interface RuntimeTracingConfig {
  readonly serviceName: string;
  readonly includeFiberIds: boolean;
  readonly includeRequestContext: boolean;
}

export interface LoadRuntimeConfigInput {
  readonly configPath?: RuntimeConfigPath;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface RuntimeProcessConfig {
  readonly configPath: RuntimeConfigPath;
  readonly configDirectory: string;
  readonly environment: RuntimeEnvironment;
  readonly logging: RuntimeLoggingConfig;
  readonly tracing: RuntimeTracingConfig;
  readonly app: MoltZapAppConfig;
  readonly server: LoadedConfig;
}

export class RuntimeConfigSurfaceError extends Data.TaggedError(
  "RuntimeConfigSurfaceError",
)<{
  readonly cause:
    | {
        readonly _tag: "ConfigFileUnreadable";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "ConfigFileInvalid";
        readonly path: string;
        readonly message: string;
      }
    | {
        readonly _tag: "EnvironmentInvalid";
        readonly key: string;
        readonly message: string;
      };
}> {}

type ProcessEnvSnapshot = Readonly<Record<string, string | undefined>>;

const DEFAULT_RUNTIME_ENVIRONMENT: RuntimeEnvironment = "development";
const DEFAULT_LOG_LEVEL: RuntimeLogLevel = "info";
const DEFAULT_SERVICE_NAME = "moltzap-server";

function resolveRuntimeConfigPath(
  input: LoadRuntimeConfigInput,
  processEnv: ProcessEnvSnapshot,
): RuntimeConfigPath {
  const selected =
    input.configPath ?? processEnv["MOLTZAP_CONFIG"] ?? "moltzap.yaml";
  return selected as RuntimeConfigPath;
}

function replaceProcessEnv(next: ProcessEnvSnapshot): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

function withPatchedProcessEnv<A, E, R>(
  processEnv: ProcessEnvSnapshot,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = { ...process.env };
      replaceProcessEnv(processEnv);
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        replaceProcessEnv(previous);
      }),
  );
}

function mapConfigLoadError(
  configPath: RuntimeConfigPath,
  error: ConfigLoadError,
): RuntimeConfigSurfaceError {
  switch (error.kind) {
    case "read":
      return new RuntimeConfigSurfaceError({
        cause: {
          _tag: "ConfigFileUnreadable",
          path: configPath,
          message: error.message,
        },
      });
    case "env": {
      const missingKey = error.message.match(/"([^"]+)"/)?.[1] ?? "unknown";
      return new RuntimeConfigSurfaceError({
        cause: {
          _tag: "EnvironmentInvalid",
          key: missingKey,
          message: error.message,
        },
      });
    }
    case "yaml":
    case "validation":
      return new RuntimeConfigSurfaceError({
        cause: {
          _tag: "ConfigFileInvalid",
          path: configPath,
          message: error.message,
        },
      });
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

function resolveRuntimeEnvironment(
  raw: string | undefined,
): Effect.Effect<RuntimeEnvironment, RuntimeConfigSurfaceError, never> {
  if (raw === undefined || raw.length === 0) {
    return Effect.succeed(DEFAULT_RUNTIME_ENVIRONMENT);
  }
  switch (raw) {
    case "development":
    case "test":
    case "production":
      return Effect.succeed(raw);
    default:
      return Effect.fail(
        new RuntimeConfigSurfaceError({
          cause: {
            _tag: "EnvironmentInvalid",
            key: "NODE_ENV",
            message: `NODE_ENV must be one of development, test, production; received "${raw}"`,
          },
        }),
      );
  }
}

function resolveRuntimeLogLevel(
  raw: string | undefined,
): Effect.Effect<RuntimeLogLevel, RuntimeConfigSurfaceError, never> {
  if (raw === undefined || raw.length === 0) {
    return Effect.succeed(DEFAULT_LOG_LEVEL);
  }
  switch (raw) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return Effect.succeed(raw);
    default:
      return Effect.fail(
        new RuntimeConfigSurfaceError({
          cause: {
            _tag: "EnvironmentInvalid",
            key: "LOG_LEVEL",
            message: `LOG_LEVEL must be one of debug, info, warn, error; received "${raw}"`,
          },
        }),
      );
  }
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
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return Effect.succeed(true);
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return Effect.succeed(false);
  }
  return Effect.fail(
    new RuntimeConfigSurfaceError({
      cause: {
        _tag: "EnvironmentInvalid",
        key,
        message: `${key} must be a boolean-like value (true/false/1/0/yes/no/on/off); received "${raw}"`,
      },
    }),
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
      new RuntimeConfigSurfaceError({
        cause: {
          _tag: "EnvironmentInvalid",
          key,
          message: `${key} must be an integer; received "${raw}"`,
        },
      }),
    );
  }
  return Effect.succeed(Number.parseInt(raw, 10));
}

function resolveTracingServiceName(
  raw: string | undefined,
): Effect.Effect<string, RuntimeConfigSurfaceError, never> {
  if (raw === undefined) {
    return Effect.succeed(DEFAULT_SERVICE_NAME);
  }
  if (raw.trim().length === 0) {
    return Effect.fail(
      new RuntimeConfigSurfaceError({
        cause: {
          _tag: "EnvironmentInvalid",
          key: "OTEL_SERVICE_NAME",
          message: "OTEL_SERVICE_NAME must be a non-empty string when set",
        },
      }),
    );
  }
  return Effect.succeed(raw);
}

function buildServerConfigProviderInput(
  appConfig: MoltZapAppConfig,
  processEnv: ProcessEnvSnapshot,
): Effect.Effect<Record<string, unknown>, RuntimeConfigSurfaceError, never> {
  return Effect.gen(function* () {
    const providerInput: Record<string, unknown> = {};

    if (appConfig.database?.url !== undefined) {
      providerInput["DATABASE_URL"] = appConfig.database.url;
    }
    if (appConfig.encryption?.master_secret !== undefined) {
      providerInput["ENCRYPTION_MASTER_SECRET"] =
        appConfig.encryption.master_secret;
    }
    if (appConfig.server?.port !== undefined) {
      providerInput["PORT"] = appConfig.server.port;
    }
    if (appConfig.server?.cors_origins !== undefined) {
      providerInput["CORS_ORIGINS"] = appConfig.server.cors_origins.join(",");
    }
    if (appConfig.dev_mode?.enabled !== undefined) {
      providerInput["MOLTZAP_DEV_MODE"] = appConfig.dev_mode.enabled;
    }

    if (processEnv["DATABASE_URL"] !== undefined) {
      providerInput["DATABASE_URL"] = processEnv["DATABASE_URL"];
    }
    if (processEnv["ENCRYPTION_MASTER_SECRET"] !== undefined) {
      providerInput["ENCRYPTION_MASTER_SECRET"] =
        processEnv["ENCRYPTION_MASTER_SECRET"];
    }
    if (processEnv["CORS_ORIGINS"] !== undefined) {
      providerInput["CORS_ORIGINS"] = processEnv["CORS_ORIGINS"];
    }

    const port = yield* parseIntegerEnv(processEnv["PORT"], "PORT");
    if (port !== undefined) {
      providerInput["PORT"] = port;
    }

    const devMode = yield* parseBooleanEnv(
      processEnv["MOLTZAP_DEV_MODE"],
      "MOLTZAP_DEV_MODE",
      appConfig.dev_mode?.enabled ?? false,
    );
    providerInput["MOLTZAP_DEV_MODE"] = devMode;

    return providerInput;
  });
}

/** Empty app config used when no YAML file is found on the auto-discovery path. */
const EMPTY_APP_CONFIG: MoltZapAppConfig & { _configDir: string } = {
  _configDir: process.cwd(),
};

export function loadRuntimeProcessConfig(
  input: LoadRuntimeConfigInput,
): Effect.Effect<RuntimeProcessConfig, RuntimeConfigSurfaceError, never> {
  return Effect.gen(function* () {
    const processEnv = input.processEnv ?? process.env;
    const configPath = resolveRuntimeConfigPath(input, processEnv);

    // Whether the operator explicitly asked for a config file (CLI arg or env
    // var). When false, a missing file is not an error — the server boots with
    // PGlite + no encryption as the zero-config quickstart default.
    const isExplicitConfigPath =
      input.configPath !== undefined ||
      processEnv["MOLTZAP_CONFIG"] !== undefined;

    const loadedAppConfig = yield* withPatchedProcessEnv(
      processEnv,
      loadConfigFromFile(configPath),
    ).pipe(
      Effect.catchIf(
        (error): error is ConfigLoadError =>
          error instanceof ConfigLoadError &&
          error.kind === "read" &&
          !isExplicitConfigPath,
        () => Effect.succeed(EMPTY_APP_CONFIG),
      ),
      Effect.mapError((error) => mapConfigLoadError(configPath, error)),
    );

    // `_configDir` is set by loadConfigFromFile (dirname of the resolved path)
    // or by EMPTY_APP_CONFIG (process.cwd()) when no YAML file was found.
    const configDirectory = loadedAppConfig._configDir;

    const environment = yield* resolveRuntimeEnvironment(
      processEnv["NODE_ENV"],
    );
    const loggingLevel = yield* resolveRuntimeLogLevel(
      processEnv["LOG_LEVEL"] ?? loadedAppConfig.log_level,
    );
    const tracingServiceName = yield* resolveTracingServiceName(
      processEnv["OTEL_SERVICE_NAME"],
    );
    const includeFiberIds = yield* parseBooleanEnv(
      processEnv["MOLTZAP_INCLUDE_FIBER_IDS"],
      "MOLTZAP_INCLUDE_FIBER_IDS",
      true,
    );
    const includeRequestContext = yield* parseBooleanEnv(
      processEnv["MOLTZAP_INCLUDE_REQUEST_CONTEXT"],
      "MOLTZAP_INCLUDE_REQUEST_CONTEXT",
      true,
    );

    const { _configDir, ...app } = loadedAppConfig;
    void _configDir;
    const serverProviderInput = yield* buildServerConfigProviderInput(
      app,
      processEnv,
    );
    const server = yield* ServerConfigLoader.pipe(
      Effect.withConfigProvider(ConfigProvider.fromJson(serverProviderInput)),
      Effect.mapError(
        (configError) =>
          new RuntimeConfigSurfaceError({
            cause: {
              _tag: "ConfigFileInvalid",
              path: configPath,
              message: `Invalid runtime config in "${configPath}": ${formatConfigError(configError)}`,
            },
          }),
      ),
    );

    return {
      configPath,
      configDirectory,
      environment,
      logging: {
        level: loggingLevel,
        preserveLegacyFields: true,
      },
      tracing: {
        serviceName: tracingServiceName,
        includeFiberIds,
        includeRequestContext,
      },
      app,
      server,
    };
  });
}
