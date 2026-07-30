import { Path } from "@effect/platform";
import { Config, ConfigProvider, Effect, Option } from "effect";

const MOLTZAP_DIR_NAME = ".moltzap";
const CONFIG_FILE_NAME = "config.json";
const SERVICE_SOCKET_FILE_NAME = "service.sock";

const configHome = Config.option(Config.string("MOLTZAP_CONFIG_HOME"));
const homeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
);

const getConfigHomeSync = (): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      configHome.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );

const getHomeDirSync = (): string =>
  Effect.runSync(
    homeDir.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );

const pathSync = <A>(f: (path: Path.Path) => A): A =>
  Effect.runSync(Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)));

const getMoltZapHomeDir = (): string =>
  pathSync((path) => path.join(getHomeDirSync(), MOLTZAP_DIR_NAME));

/**
 * Provides the get molt zap config dir runtime value.
 * @returns The get molt zap config dir result.
 */
export const getMoltZapConfigDir = (): string =>
  getConfigHomeSync() ?? getMoltZapHomeDir();

/**
 * Provides the get molt zap config path runtime value.
 * @returns The get molt zap config path result.
 */
export const getMoltZapConfigPath = (): string =>
  pathSync((path) => path.join(getMoltZapConfigDir(), CONFIG_FILE_NAME));

/**
 * Provides the get molt zap service socket path runtime value.
 * @returns The get molt zap service socket path result.
 */
export const getMoltZapServiceSocketPath = (): string =>
  pathSync((path) =>
    path.join(getMoltZapConfigDir(), SERVICE_SOCKET_FILE_NAME),
  );

/**
 * Provides the get molt zap agent service socket path runtime value.
 * @param agentId Identifier of the agent targeted by the operation.
 * @returns The get molt zap agent service socket path result.
 */
export const getMoltZapAgentServiceSocketPath = (agentId: string): string =>
  pathSync((path) =>
    path.join(getMoltZapConfigDir(), `service-${agentId}.sock`),
  );
