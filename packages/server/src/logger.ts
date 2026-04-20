/**
 * Pino-backed logger, injectable via `LoggerTag`.
 *
 * `LoggerLive` reads `LOG_LEVEL` / `NODE_ENV` through `Effect.Config` inside
 * `Layer.effect` — so env vars are resolved at Layer evaluation time (via
 * whatever `ConfigProvider` the runtime is using), not at module import.
 *
 * Effect-context code pulls the instance via `LoggerTag`. Sync paths that
 * can't sit inside an Effect (pool error listeners, top-level bootstrap,
 * direct CLI entry) use `getLogger()` — it returns the Layer-built instance
 * once `LoggerLive` has run, else a bootstrap pino with defaults.
 */
import { Config, Context, Effect, Layer, Logger as EffectLogger } from "effect";
import pino from "pino";

export type Logger = pino.Logger;

/** Context tag for the root pino logger. Provided by `LoggerLive`. */
export class LoggerTag extends Context.Tag("moltzap/Logger")<
  LoggerTag,
  Logger
>() {}

/**
 * Singleton written by `LoggerLive` on first build. Read by `getLogger()`
 * and the `effectLogger` bridge so every log — sync or Effect — lands on the
 * same pino stream.
 */
let current: Logger | null = null;

/** Bootstrap pino with defaults only — no env reads. */
let bootstrap: Logger | null = null;
function getBootstrap(): Logger {
  if (!bootstrap) bootstrap = pino({ level: "info" });
  return bootstrap;
}

/**
 * Returns the Layer-built pino once `LoggerLive` has evaluated, otherwise
 * a bootstrap default. Sync accessor for paths that can't pull `LoggerTag`
 * from an Effect context.
 */
export function getLogger(): Logger {
  return current ?? getBootstrap();
}

/**
 * @deprecated Prefer `LoggerTag` from Effect context, or `getLogger()` for
 * sync paths. Kept as a transparent Proxy over `getLogger()` so legacy call
 * sites using `logger.info(...)` continue to work during migration.
 */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop) {
    const target = getLogger();
    const value = Reflect.get(target, prop);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  },
}) as Logger;

/** Build pino from Effect.Config — env reads happen here, at Layer build. */
const buildPino = Effect.gen(function* () {
  const level = yield* Config.string("LOG_LEVEL").pipe(
    Config.withDefault("info"),
  );
  const nodeEnv = yield* Config.string("NODE_ENV").pipe(
    Config.withDefault("development"),
  );
  const instance = pino({
    level,
    transport:
      nodeEnv !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
  current = instance;
  return instance;
});

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
 * Effect `Logger` that writes to the current pino instance. Annotations added
 * via `Effect.annotateLogs({...})` become the first-arg object on the Pino
 * call, matching the pre-migration `logger.info({...}, "msg")` shape so
 * operator tooling sees no format change.
 */
export const effectLogger = EffectLogger.make(
  ({ logLevel, message, annotations }) => {
    const log = getLogger();
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
      log[pinoMethod](mergedAnnotations, msg);
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
 * Provides `LoggerTag` (pino built from `Effect.Config`) AND replaces
 * Effect's default (console) logger with the pino-backed `effectLogger` so
 * `Effect.log*` calls inside services flow through the same stream.
 */
export const LoggerLive = Layer.mergeAll(
  Layer.effect(LoggerTag, buildPino),
  EffectLogger.replace(EffectLogger.defaultLogger, effectLogger),
);
