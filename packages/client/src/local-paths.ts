/**
 * @file Resolves the read-only Client configuration path from an explicit
 * config home or the platform home-directory environment.
 */

import { Path } from "@effect/platform";
import { Config, ConfigProvider, Effect, Option } from "effect";

const MOLTZAP_DIR_NAME = ".moltzap";
const CONFIG_FILE_NAME = "config.json";

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
 * Resolves the directory containing the endpoint's local configuration.
 * @returns The explicit config home, or the conventional directory under home.
 */
const getMoltZapConfigDir = (): string =>
  getConfigHomeSync() ?? getMoltZapHomeDir();

/**
 * Resolves the config file without reading or creating it.
 * @returns The endpoint configuration file path.
 */
export const getMoltZapConfigPath = (): string =>
  pathSync((path) => path.join(getMoltZapConfigDir(), CONFIG_FILE_NAME));
