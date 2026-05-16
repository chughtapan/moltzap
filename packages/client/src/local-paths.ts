import { Path } from "@effect/platform";
import { Config, ConfigProvider, Effect, Option } from "effect";

const MOLTZAP_DIR_NAME = ".moltzap";
const OPENCLAW_DIR_NAME = ".openclaw";
const CONFIG_FILE_NAME = "config.json";
const OPENCLAW_CONFIG_FILE_NAME = "openclaw.json";
const SERVICE_SOCKET_FILE_NAME = "service.sock";

const ConfigHome = Config.option(Config.string("MOLTZAP_CONFIG_HOME"));
const HomeDir = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
);

const getConfigHomeSync = (): string | undefined =>
  Option.getOrUndefined(
    Effect.runSync(
      ConfigHome.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );

const getHomeDirSync = (): string =>
  Effect.runSync(
    HomeDir.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
  );

const pathSync = <A>(f: (path: Path.Path) => A): A =>
  Effect.runSync(Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)));

const getMoltZapHomeDir = (): string =>
  pathSync((path) => path.join(getHomeDirSync(), MOLTZAP_DIR_NAME));

export const getMoltZapConfigDir = (): string =>
  getConfigHomeSync() ?? getMoltZapHomeDir();

export const getMoltZapConfigPath = (): string =>
  pathSync((path) => path.join(getMoltZapConfigDir(), CONFIG_FILE_NAME));

export const getMoltZapServiceSocketPath = (): string =>
  pathSync((path) => path.join(getMoltZapHomeDir(), SERVICE_SOCKET_FILE_NAME));

export const getMoltZapAgentServiceSocketPath = (agentId: string): string =>
  pathSync((path) => path.join(getMoltZapHomeDir(), `service-${agentId}.sock`));

export const getOpenClawConfigDir = (): string =>
  pathSync((path) => path.join(getHomeDirSync(), OPENCLAW_DIR_NAME));

export const getOpenClawConfigPath = (): string =>
  pathSync((path) =>
    path.join(getOpenClawConfigDir(), OPENCLAW_CONFIG_FILE_NAME),
  );
