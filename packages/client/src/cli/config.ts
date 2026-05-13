import * as path from "node:path";
import * as os from "node:os";
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
const CONFIG_FILE_NAME = "config.json";
const ConfigHome = Config.option(Config.string("MOLTZAP_CONFIG_HOME"));

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

const getConfigHomeSync = (): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      ConfigHome.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );

const getConfigDir = (): string =>
  getConfigHomeSync() ?? path.join(os.homedir(), ".moltzap");

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read the on-disk JSON (best-effort: ENOENT → empty object). */
const readJsonFile = (): Effect.Effect<
  Record<string, unknown>,
  ConfigReadError
> =>
  Effect.gen(function* () {
    const configPath = getConfigPath();
    const text = yield* FileSystem.FileSystem.pipe(
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
      Effect.either,
      Effect.flatMap(
        Either.match({
          onLeft: (cause) =>
            Effect.fail(
              new ConfigReadError({
                cause,
                message: `Failed to read ${configPath}: ${cause.message}`,
                path: configPath,
              }),
            ),
          onRight: (value) => Effect.succeed(value),
        }),
      ),
    );
    if (text === null) return {};
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (err) =>
        new ConfigReadError({
          cause: err,
          message: `Failed to parse ${configPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          path: configPath,
        }),
    });
    if (!isRecord(parsed)) {
      return yield* Effect.fail(
        new ConfigReadError({
          cause: "config root is not a JSON object",
          message: `Failed to parse ${configPath}: config root is not a JSON object`,
          path: configPath,
        }),
      );
    }
    return parsed;
  });

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

  const env: Record<string, string> = {};
  const envOverrides = yield* EnvOverrideSchema.pipe(
    Effect.withConfigProvider(ConfigProvider.fromEnv()),
    Effect.orElseSucceed(() => ({
      apiKey: Option.none<Redacted.Redacted<string>>(),
      serverUrl: Option.none<string>(),
    })),
  );
  Option.match(envOverrides.serverUrl, {
    onNone: () => undefined,
    onSome: (value) => {
      env.serverUrl = value;
    },
  });
  Option.match(envOverrides.apiKey, {
    onNone: () => undefined,
    onSome: (value) => {
      env.apiKey = Redacted.value(value);
    },
  });

  const provider = ConfigProvider.fromJson({ ...json, ...env });
  const value = yield* ConfigSchema.pipe(
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

  const result: MoltZapConfig = { serverUrl: value.serverUrl };
  Option.match(value.apiKey, {
    onNone: () => undefined,
    onSome: (value) => {
      result.apiKey = Redacted.value(value);
    },
  });
  Option.match(value.agentName, {
    onNone: () => undefined,
    onSome: (value) => {
      result.agentName = value;
    },
  });
  return result;
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
