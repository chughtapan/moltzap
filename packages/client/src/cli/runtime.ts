/**
 * Effect runtime, logger, and process boundary for the `moltzap` CLI.
 *
 * The CLI is Effect-native end to end — commands build Effects, and the
 * process entry runs a single `NodeRuntime.runMain` at `index.ts`. No
 * per-command `Effect.runPromise`.
 *
 * Logging is Pino under the hood (matching the server's pattern) wrapped
 * as an Effect `Logger` so `Effect.logInfo(...).pipe(Effect.annotateLogs(...))`
 * inside commands routes through the same output format.
 */
import {
  Config,
  ConfigProvider,
  Effect,
  Logger as EffectLogger,
  LogLevel,
} from "effect";
import pino from "pino";

const CliRuntimeEnv = Config.all({
  logLevel: Config.string("MOLTZAP_LOG_LEVEL").pipe(Config.withDefault("info")),
  nodeEnv: Config.string("NODE_ENV").pipe(Config.withDefault("development")),
});

const runtimeEnv = Effect.runSync(
  CliRuntimeEnv.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
);

const PINO = pino({
  level: runtimeEnv.logLevel,
  transport:
    runtimeEnv.nodeEnv !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

const LEVEL_TO_PINO: Record<
  string,
  "trace" | "debug" | "info" | "warn" | "error" | "fatal"
> = {
  All: "trace",
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warning: "warn",
  Error: "error",
  Fatal: "fatal",
  None: "trace",
};

function formatEffectLogMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message) && message.length === 1) {
    return String(message[0]);
  }
  return String(message);
}

/**
 * Effect `Logger` backed by a Pino instance. Same wrapping shape as the
 * server's `effectLogger` — annotations become Pino's first-arg object,
 * the message is the string payload.
 */
const effectLogger = EffectLogger.make(({ logLevel, message, annotations }) => {
  const merged: Record<string, unknown> = {};
  for (const [k, v] of annotations) merged[k] = v;
  const pinoMethod = LEVEL_TO_PINO[logLevel._tag] ?? "info";
  const msg = formatEffectLogMessage(message);
  PINO[pinoMethod](merged, msg);
});

/**
 * Replaces Effect's default console logger at the root of the program,
 * and honors `MOLTZAP_LOG_LEVEL` (default "info") for minimum level.
 */
export const LoggerLive = EffectLogger.replace(
  EffectLogger.defaultLogger,
  effectLogger,
).pipe(
  // Pino does its own level filtering, but we also gate via Effect so
  // sub-info annotations don't build objects unnecessarily.
  (layer) => layer,
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
