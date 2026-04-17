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
import { Logger as EffectLogger, LogLevel } from "effect";
import pino from "pino";

const PINO = pino({
  level: process.env["MOLTZAP_LOG_LEVEL"] ?? "info",
  transport:
    process.env["NODE_ENV"] !== "production"
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

/**
 * Effect `Logger` backed by a Pino instance. Same wrapping shape as the
 * server's `effectLogger` — annotations become Pino's first-arg object,
 * the message is the string payload. Pino throw (shutdown transport
 * torn down, etc.) is swallowed to stderr so the Effect fiber doesn't
 * die on a log-write failure.
 */
export const effectLogger = EffectLogger.make(
  ({ logLevel, message, annotations }) => {
    const merged: Record<string, unknown> = {};
    for (const [k, v] of annotations) merged[k] = v;
    const pinoMethod = LEVEL_TO_PINO[logLevel._tag] ?? "info";
    const msg =
      typeof message === "string"
        ? message
        : Array.isArray(message) && message.length === 1
          ? String(message[0])
          : String(message);
    try {
      PINO[pinoMethod](merged, msg);
    } catch (err) {
      try {
        process.stderr.write(
          `[cli-logger-fallback] ${msg} (${
            err instanceof Error ? err.message : String(err)
          })\n`,
        );
        // #ignore-sloppy-code-next-line[bare-catch]: inner fallback for stderr write failure — last resort, nothing to log to
      } catch (_innerErr) {
        // stderr unavailable — drop rather than crash.
      }
    }
  },
);

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
  const env = (process.env["MOLTZAP_LOG_LEVEL"] ?? "info").toLowerCase();
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

/** Pino instance for raw synchronous logging (e.g. fatal exits). */
export const rawLogger = PINO;
