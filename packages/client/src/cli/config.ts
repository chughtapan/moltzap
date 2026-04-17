import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Config, ConfigProvider, Effect } from "effect";

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

const CONFIG_DIR = path.join(os.homedir(), ".moltzap");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULT_SERVER_URL = "wss://api.moltzap.xyz";

/** Effect.Config schema. Matches the on-disk JSON shape. */
const ConfigSchema = Config.all({
  serverUrl: Config.string("serverUrl").pipe(
    Config.withDefault(DEFAULT_SERVER_URL),
  ),
  apiKey: Config.option(Config.string("apiKey")),
  agentName: Config.option(Config.string("agentName")),
});

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/** Read the on-disk JSON (best-effort: ENOENT → empty object). */
const readJsonFile = (): Effect.Effect<Record<string, unknown>, Error> =>
  Effect.try({
    try: () => {
      try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<
          string,
          unknown
        >;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return {};
        throw err;
      }
    },
    catch: (err) =>
      new Error(
        `Failed to read ${CONFIG_PATH}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  });

/**
 * Load and validate the CLI config. Merges on-disk JSON with env overrides
 * (MOLTZAP_SERVER_URL, MOLTZAP_API_KEY) through a single `ConfigProvider`.
 * Missing file resolves with defaults; parse errors surface as typed
 * failures so callers see them instead of getting silent defaults.
 */
export const loadConfig: Effect.Effect<MoltZapConfig, Error> = Effect.gen(
  function* () {
    const json = yield* readJsonFile();

    const env: Record<string, string> = {};
    if (process.env.MOLTZAP_SERVER_URL)
      env.serverUrl = process.env.MOLTZAP_SERVER_URL;
    if (process.env.MOLTZAP_API_KEY) env.apiKey = process.env.MOLTZAP_API_KEY;

    const provider = ConfigProvider.fromJson({ ...json, ...env });
    const value = yield* ConfigSchema.pipe(
      Effect.withConfigProvider(provider),
      Effect.mapError(
        (cause) => new Error(`Invalid config in ${CONFIG_PATH}: ${cause}`),
      ),
    );

    const result: MoltZapConfig = { serverUrl: value.serverUrl };
    if (value.apiKey._tag === "Some") result.apiKey = value.apiKey.value;
    if (value.agentName._tag === "Some")
      result.agentName = value.agentName.value;
    return result;
  },
);

/** Write a new config blob to disk. Used by `moltzap register` post-registration. */
export const writeConfig = (
  config: MoltZapConfig,
): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
      });
    },
    catch: (err) =>
      new Error(
        `Failed to write ${CONFIG_PATH}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  });

/** Load-modify-write helper. */
export const updateConfig = (
  updater: (config: MoltZapConfig) => MoltZapConfig,
): Effect.Effect<void, Error> =>
  loadConfig.pipe(Effect.flatMap((current) => writeConfig(updater(current))));

/** WebSocket server URL (env-overridable). */
export const getServerUrl: Effect.Effect<string, Error> = loadConfig.pipe(
  Effect.map((c) => c.serverUrl),
);

/** HTTP base URL — ws/wss → http/https. */
export const getHttpUrl: Effect.Effect<string, Error> = getServerUrl.pipe(
  Effect.map((url) => url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")),
);

/** Resolve agent API key. Fails if neither env nor config has one set. */
export const resolveAuth: Effect.Effect<{ agentKey: string }, Error> =
  loadConfig.pipe(
    Effect.flatMap((config) =>
      config.apiKey
        ? Effect.succeed({ agentKey: config.apiKey })
        : Effect.fail(
            new Error("No agent registered. Run `moltzap register` first."),
          ),
    ),
  );
