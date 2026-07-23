/**
 * Effect runtime, logger, and process boundary for the `moltzap` CLI.
 *
 * The CLI is Effect-native end to end — commands build Effects, and the
 * process entry runs a single `NodeRuntime.runMain` at `index.ts`. No
 * per-command `Effect.runPromise`.
 *
 * Logging uses Effect's built-in logger. CLI command output owns stdout, so
 * logs go to stderr.
 */
import { Config, ConfigProvider, Effect, Logger, LogLevel } from "effect";

// safer-arch-ignore no-trivial-sink-file: this module is the CLI's Effect runtime and logging composition seam, consumed only by the process entrypoint.
const CliRuntimeEnv = Config.all({
  logLevel: Config.string("MOLTZAP_LOG_LEVEL").pipe(Config.withDefault("info")),
});

const runtimeEnv = Effect.runSync(
  CliRuntimeEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
);

/**
 * Replaces Effect's default console logger at the root of the program.
 * `cli/index.ts` applies `minLogLevel`.
 */
export const LoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.withConsoleError(Logger.stringLogger),
);

/**
 * Minimum Effect log level, mapped from MOLTZAP_LOG_LEVEL.
 * Used when composing layers at the CLI entrypoint.
 */
export const minLogLevel: LogLevel.LogLevel = (() => {
  const env = runtimeEnv.logLevel.toLowerCase();
  switch (env) {
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warn":
    case "warning":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    default:
      return LogLevel.Info;
  }
})();
