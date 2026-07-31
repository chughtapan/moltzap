import { Path } from "@effect/platform";
import { Config, ConfigProvider, Effect, Option } from "effect";

const MOLTZAP_DIR_NAME = ".moltzap";
const CONFIG_FILE_NAME = "config.json";
const SERVICE_SOCKET_FILE_NAME = "service.sock";

const ConfigHome = Config.option(Config.string("MOLTZAP_CONFIG_HOME"));
const HomeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
);

function getConfigHomeSync(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      ConfigHome.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );
}

function getHomeDirSync(): string {
  return Effect.runSync(
    HomeDir.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
}

function getMoltZapHomeDir(): string {
  return pathSync((path) => path.join(getHomeDirSync(), MOLTZAP_DIR_NAME));
}

export const getMoltZapConfigDir = (): string =>
  getConfigHomeSync() ?? getMoltZapHomeDir();

export const getMoltZapConfigPath = (): string =>
  pathSync((path) => path.join(getMoltZapConfigDir(), CONFIG_FILE_NAME));

export const getMoltZapServiceSocketPath = (): string =>
  pathSync((path) =>
    path.join(getMoltZapConfigDir(), SERVICE_SOCKET_FILE_NAME),
  );

export const getMoltZapAgentServiceSocketPath = (agentId: string): string =>
  pathSync((path) =>
    path.join(getMoltZapConfigDir(), `service-${agentId}.sock`),
  );
