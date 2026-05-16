import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Either,
  Option,
  Redacted,
} from "effect";
import { getMoltZapConfigDir, getMoltZapConfigPath } from "../local-paths.js";

/**
 * CLI config shape. Loaded via `Effect.Config` from the on-disk JSON file
 * merged with process.env overrides. `apiKey` and `agentName` are populated
 * by `moltzap register`.
 */
export interface MoltZapConfig {
  serverUrl: string;
  apiKey?: string;
  agentName?: string;
}

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";
const CONFIG_FILE_MODE = 0o600;
const JSON_INDENT_SPACES = 2;

export type CliConfigError =
  | ConfigReadError
  | ConfigWriteError
  | ConfigInvalidError
  | AuthNotConfiguredError;

export class ConfigReadError extends Data.TaggedError("ConfigReadError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
}> {}

export class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
}> {}

export class ConfigInvalidError extends Data.TaggedError("ConfigInvalidError")<{
  readonly cause: unknown;
  readonly message: string;
  readonly path: string;
}> {}

export class AuthNotConfiguredError extends Data.TaggedError(
  "AuthNotConfiguredError",
)<{
  readonly message: string;
}> {}

/** Effect.Config schema. Matches the on-disk JSON shape. */
const ConfigSchema = Config.all({
  serverUrl: Config.string("serverUrl").pipe(
    Config.withDefault(DEFAULT_SERVER_URL),
  ),
  apiKey: Config.option(Config.redacted("apiKey")),
  agentName: Config.option(Config.string("agentName")),
});
const EnvOverrideSchema = Config.all({
  apiKey: Config.option(Config.redacted("MOLTZAP_API_KEY")),
  serverUrl: Config.option(Config.string("MOLTZAP_SERVER_URL")),
});

interface EnvOverrides {
  readonly apiKey: Option.Option<Redacted.Redacted<string>>;
  readonly serverUrl: Option.Option<string>;
}

interface DecodedConfig {
  readonly serverUrl: string;
  readonly apiKey: Option.Option<Redacted.Redacted<string>>;
  readonly agentName: Option.Option<string>;
}

export function getConfigPath(): string {
  return getMoltZapConfigPath();
}

const getConfigDir = getMoltZapConfigDir;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function configReadError(
  configPath: string,
  cause: unknown,
  detail: string,
): ConfigReadError {
  return new ConfigReadError({
    cause,
    message: `Failed to ${detail} ${configPath}: ${describeCause(cause)}`,
    path: configPath,
  });
}

const readConfigFileText = (
  configPath: string,
): Effect.Effect<string | null, ConfigReadError> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem
        .exists(configPath)
        .pipe(
          Effect.flatMap((exists) =>
            exists
              ? fileSystem.readFileString(configPath, "utf-8")
              : Effect.succeed(null),
          ),
        ),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.mapError((cause) => configReadError(configPath, cause, "read")),
  );

const parseConfigJson = (
  configPath: string,
  text: string,
): Effect.Effect<unknown, ConfigReadError> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (err) => configReadError(configPath, err, "parse"),
  });

const requireConfigRecord = (
  configPath: string,
  parsed: unknown,
): Effect.Effect<Record<string, unknown>, ConfigReadError> =>
  isRecord(parsed)
    ? Effect.succeed(parsed)
    : Effect.fail(
        new ConfigReadError({
          cause: "config root is not a JSON object",
          message: `Failed to parse ${configPath}: config root is not a JSON object`,
          path: configPath,
        }),
      );

/** Read the on-disk JSON (best-effort: ENOENT → empty object). */
const readJsonFile = (): Effect.Effect<
  Record<string, unknown>,
  ConfigReadError
> =>
  Effect.gen(function* () {
    const configPath = getConfigPath();
    const text = yield* readConfigFileText(configPath);
    if (text === null) return {};
    const parsed = yield* parseConfigJson(configPath, text);
    return yield* requireConfigRecord(configPath, parsed);
  });

const readEnvOverrides = (): Effect.Effect<EnvOverrides, never> =>
  EnvOverrideSchema.pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.orElseSucceed(() => ({
      apiKey: Option.none<Redacted.Redacted<string>>(),
      serverUrl: Option.none<string>(),
    })),
  );

function envRecordFromOverrides(
  overrides: EnvOverrides,
): Record<string, string> {
  const env: Record<string, string> = {};
  Option.match(overrides.serverUrl, {
    onNone: () => undefined,
    onSome: (value) => {
      env.serverUrl = value;
    },
  });
  Option.match(overrides.apiKey, {
    onNone: () => undefined,
    onSome: (value) => {
      env.apiKey = Redacted.value(value);
    },
  });
  return env;
}

const decodeConfigValue = (
  configPath: string,
  provider: ConfigProvider.ConfigProvider,
): Effect.Effect<DecodedConfig, ConfigInvalidError> =>
  ConfigSchema.pipe(
    Effect.withConfigProvider(provider),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(
            new ConfigInvalidError({
              cause,
              message: `Invalid config in ${configPath}: ${cause}`,
              path: configPath,
            }),
          ),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );

function toMoltZapConfig(value: DecodedConfig): MoltZapConfig {
  const result: MoltZapConfig = { serverUrl: value.serverUrl };
  Option.match(value.apiKey, {
    onNone: () => undefined,
    onSome: (apiKey) => {
      result.apiKey = Redacted.value(apiKey);
    },
  });
  Option.match(value.agentName, {
    onNone: () => undefined,
    onSome: (agentName) => {
      result.agentName = agentName;
    },
  });
  return result;
}

/**
 * Load and validate the CLI config. Merges on-disk JSON with env overrides
 * (MOLTZAP_SERVER_URL, MOLTZAP_API_KEY) through a single `ConfigProvider`.
 * Missing file resolves with defaults; parse errors surface as typed
 * failures so callers see them instead of getting silent defaults.
 */
export const loadConfig: Effect.Effect<
  MoltZapConfig,
  ConfigReadError | ConfigInvalidError
> = Effect.gen(function* () {
  const configPath = getConfigPath();
  const json = yield* readJsonFile();
  const env = envRecordFromOverrides(yield* readEnvOverrides());
  const provider = ConfigProvider.fromJson({ ...json, ...env });
  return toMoltZapConfig(yield* decodeConfigValue(configPath, provider));
}).pipe(Effect.withSpan("loadConfig"));

/** Write a new config blob to disk. Used by `moltzap register` post-registration. */
const writeConfig = (
  config: MoltZapConfig,
): Effect.Effect<void, ConfigWriteError> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => {
      const configDir = getConfigDir();
      const configPath = getConfigPath();
      return fileSystem.makeDirectory(configDir, { recursive: true }).pipe(
        Effect.zipRight(
          fileSystem.writeFileString(
            configPath,
            JSON.stringify(config, null, JSON_INDENT_SPACES) + "\n",
            { mode: CONFIG_FILE_MODE },
          ),
        ),
        Effect.either,
        Effect.flatMap(
          Either.match({
            onLeft: (cause) =>
              Effect.fail(
                new ConfigWriteError({
                  cause,
                  message: `Failed to write ${configPath}: ${cause.message}`,
                  path: configPath,
                }),
              ),
            onRight: (value) => Effect.succeed(value),
          }),
        ),
      );
    }),
    Effect.provide(NodeFileSystem.layer),
  );

/** Load-modify-write helper. */
export const updateConfig = (
  updater: (config: MoltZapConfig) => MoltZapConfig,
): Effect.Effect<
  void,
  ConfigInvalidError | ConfigReadError | ConfigWriteError
> =>
  loadConfig.pipe(Effect.flatMap((current) => writeConfig(updater(current))));

/** WebSocket server URL (env-overridable). */
export const getServerUrl: Effect.Effect<
  string,
  ConfigInvalidError | ConfigReadError
> = loadConfig.pipe(Effect.map((c) => c.serverUrl));

/** HTTP base URL — ws/wss → http/https. */
export const getHttpUrl: Effect.Effect<
  string,
  ConfigInvalidError | ConfigReadError
> = getServerUrl.pipe(
  Effect.map((url) => url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")),
);

/** Resolve agent API key. Fails if neither env nor config has one set. */
export const resolveAuth: Effect.Effect<
  { agentKey: string },
  AuthNotConfiguredError | ConfigInvalidError | ConfigReadError
> = loadConfig.pipe(
  Effect.flatMap((config) =>
    config.apiKey
      ? Effect.succeed({ agentKey: config.apiKey })
      : Effect.fail(
          new AuthNotConfiguredError({
            message: "No agent registered. Run `moltzap register` first.",
          }),
        ),
  ),
);
