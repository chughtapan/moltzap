/**
 * Effect Logger backed by a Pino instance.
 *
 * Pino is still the actual output backend — operator-facing log format is
 * unchanged. On top of that, `effectLogger` wraps Pino as an Effect `Logger`
 * so `Effect.logInfo(...).pipe(Effect.annotateLogs({...}))` calls inside
 * services flow to the same Pino stream via `LoggerLive`.
 *
 * The Pino instance remains exported as `logger` / `Logger` so bootstrap,
 * startup, and synchronous paths that can't be inside an Effect continue
 * to work unchanged.
 */
import { Logger as EffectLogger } from "effect";
import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  transport:
    process.env["NODE_ENV"] !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export type Logger = typeof logger;

/**
 * Maps Effect's `LogLevel._tag` values to Pino's level method names. `All` /
 * `None` never appear as actual log entries in practice, but we map them
 * defensively so the level lookup never returns undefined.
 */
const levelToPino: Record<
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
 * Effect `Logger` that writes to the Pino instance. Annotations added via
 * `Effect.annotateLogs({...})` become the first-arg object on the Pino call,
 * matching the pre-migration `logger.info({...}, "msg")` shape so operator
 * tooling sees no format change.
 */
export const effectLogger = EffectLogger.make(
  ({ logLevel, message, annotations }) => {
    const mergedAnnotations: Record<string, unknown> = {};
    // HashMap iteration yields [key, value] tuples.
    for (const [k, v] of annotations) {
      mergedAnnotations[k] = v;
    }
    const pinoMethod = levelToPino[logLevel._tag] ?? "info";
    // Effect passes the message through unchanged (typically a string). Coerce
    // defensively so Pino's msg field stays printable.
    const msg =
      typeof message === "string"
        ? message
        : Array.isArray(message) && message.length === 1
          ? String(message[0])
          : String(message);
    // Pino can throw synchronously if its transport has closed (e.g. during
    // shutdown, when pino-pretty's worker has disconnected). Swallow rather
    // than letting the throw propagate as a defect through the Effect
    // runtime — a log-write failure is never worth crashing the fiber for.
    try {
      logger[pinoMethod](mergedAnnotations, msg);
    } catch (err) {
      // #ignore-sloppy-code-next-line[bare-catch]: logger failure path writes to stderr since the logger itself is broken
      try {
        process.stderr.write(
          `[logger-fallback] ${msg} (logger error: ${
            err instanceof Error ? err.message : String(err)
          })\n`,
        );
        // #ignore-sloppy-code-next-line[bare-catch]: both sinks failed — nowhere left to report
      } catch (_innerErr) {
        // stderr unavailable; drop the entry rather than crash the fiber.
      }
    }
  },
);

/**
 * Layer that replaces Effect's default (console) logger with the Pino-backed
 * Effect logger. Provide this in the top-level Layer composition so all
 * `Effect.log*` calls inside services route through Pino.
 */
export const LoggerLive = EffectLogger.replace(
  EffectLogger.defaultLogger,
  effectLogger,
);
