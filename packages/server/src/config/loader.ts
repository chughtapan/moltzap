/**
 * Load MoltZap configuration from a YAML file.
 *
 * Failures surface as a typed `ConfigLoadError` in the Effect error channel —
 * nothing is thrown. Consumers run via `Effect.runPromise` (or
 * `runPromiseExit` to inspect failures) and decide how to react.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Either,
  Match,
  Option,
  Schema,
} from "effect";
import type { ConfigError } from "effect/ConfigError";
import { MoltZapConfig, type MoltZapAppConfig } from "./effect-config.js";
import { validateConfig, formatConfigErrors } from "./schema.js";

/**
 * Top-level YAML document shape. `ConfigProvider.fromJson` silently
 * accepts any input — handing it a scalar, array, or `null` turns every
 * subsequent `Config.nested(...)` lookup into a "missing key" error that
 * hides the real problem (the file is not a config mapping). Decoding
 * at the boundary fails loudly with one clear message instead.
 */
const YamlDocumentSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
const decodeYamlDocument = Schema.decodeUnknownEither(YamlDocumentSchema);

/** Union of failure modes when loading a config file. */
export type ConfigLoadErrorKind = "read" | "yaml" | "env" | "validation";

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly kind: ConfigLoadErrorKind;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
  /** Present when `kind === "validation"` — the raw Effect ConfigError tree. */
  readonly configError?: ConfigError;
}> {}

type ProcessEnvSnapshot = Readonly<Record<string, string | undefined>>;

const readEnvValue = (
  processEnv: ProcessEnvSnapshot | undefined,
  key: string,
): string | undefined => {
  if (processEnv !== undefined) {
    return processEnv[key];
  }
  return Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(key)).pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
};

/** Interpolate `${ENV_VAR}` references in string values throughout a parsed object. */
function interpolateEnvVars(
  obj: unknown,
  path: string,
  processEnv?: ProcessEnvSnapshot,
): Effect.Effect<unknown, ConfigLoadError> {
  if (typeof obj === "string") {
    let missing: string | null = null;
    const replaced = obj.replace(
      /\$\{([^}]+)\}/g,
      (_match, varName: string) => {
        const value = readEnvValue(processEnv, varName);
        // Treat empty string the same as undefined: an accidentally empty
        // env var would otherwise silently interpolate into strings like
        // `https://${HOST}/callback` and produce a broken URL that still
        // passes `nonEmptyString` at the outer key.
        if (value === undefined || value === "") {
          if (missing === null) missing = varName;
          return "";
        }
        return value;
      },
    );
    if (missing !== null) {
      return Effect.fail(
        new ConfigLoadError({
          kind: "env",
          path,
          message: `Missing env var "${missing}" referenced in "${path}"`,
        }),
      );
    }
    return Effect.succeed(replaced);
  }
  if (Array.isArray(obj)) {
    return Effect.gen(function* () {
      const out: unknown[] = [];
      for (const value of obj) {
        out.push(yield* interpolateEnvVars(value, path, processEnv));
      }
      return out;
    });
  }
  if (obj !== null && typeof obj === "object") {
    return Effect.gen(function* () {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        out[key] = yield* interpolateEnvVars(value, path, processEnv);
      }
      return out;
    });
  }
  return Effect.succeed(obj);
}

/**
 * Load and validate a MoltZap config YAML file.
 *
 * Resolves the path with the same precedence as before: explicit arg ->
 * `MOLTZAP_CONFIG` env var -> `moltzap.yaml`.
 *
 * Returns an `Effect` that yields the parsed config plus a `_configDir`
 * (directory of the config file, used to resolve relative paths inside it).
 */
export const loadConfigFromFile = (
  path?: string,
  processEnv?: ProcessEnvSnapshot,
): Effect.Effect<MoltZapAppConfig & { _configDir: string }, ConfigLoadError> =>
  Effect.gen(function* () {
    const configPath =
      path ?? readEnvValue(processEnv, "MOLTZAP_CONFIG") ?? "moltzap.yaml";

    const raw = yield* Effect.try({
      try: () => readFileSync(configPath, "utf-8"),
      catch: (cause) =>
        new ConfigLoadError({
          kind: "read",
          path: configPath,
          message: `Cannot read config file "${configPath}": ${(cause as Error).message}`,
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: (): unknown => parseYaml(raw),
      catch: (cause) =>
        new ConfigLoadError({
          kind: "yaml",
          path: configPath,
          message: `Invalid YAML in "${configPath}": ${(cause as Error).message}`,
          cause,
        }),
    });

    const decoded = yield* Either.match(decodeYamlDocument(parsed), {
      onLeft: (cause) =>
        Effect.fail(
          new ConfigLoadError({
            kind: "yaml",
            path: configPath,
            message: `Invalid YAML in "${configPath}": top-level value must be a mapping (${cause.message})`,
            cause,
          }),
        ),
      onRight: (value) => Effect.succeed(value),
    });

    const interp = yield* interpolateEnvVars(decoded, configPath, processEnv);

    // TypeBox validation runs before Effect Config to catch type mismatches
    // (e.g. a string where a boolean is required) with clear field-level
    // messages. Effect Config coerces some primitives; TypeBox does not.
    const schemaResult = validateConfig(interp);
    if (!schemaResult.ok) {
      return yield* Effect.fail(
        new ConfigLoadError({
          kind: "validation",
          path: configPath,
          message: `Invalid config in "${configPath}":\n${formatConfigErrors(schemaResult.errors)}`,
        }),
      );
    }

    // `fromJson` walks the nested object and produces flat paths that
    // `Config.all(...)` / `Config.nested(...)` / `Config.array(...)` consume.
    const provider = ConfigProvider.fromJson(interp ?? {});

    const value = yield* MoltZapConfig.pipe(
      Effect.withConfigProvider(provider),
      Effect.mapError(
        (configError) =>
          new ConfigLoadError({
            kind: "validation",
            path: configPath,
            message: `Invalid config in "${configPath}": ${formatConfigError(configError)}`,
            configError,
          }),
      ),
    );

    let configDir: string;
    try {
      configDir = dirname(realpathSync(configPath));
    } catch (err) {
      console.warn("Failed to resolve config path symlink:", err);
      configDir = dirname(configPath);
    }

    return { ...value, _configDir: configDir };
  });

/** Walk a ConfigError tree and produce a readable string. */
function formatConfigError(err: ConfigError): string {
  const lines: string[] = [];
  const pushLeaf = (e: { path: ReadonlyArray<string>; message: string }) => {
    lines.push(`  ${e.path.join(".") || "/"}: ${e.message}`);
  };
  const walk = (e: ConfigError): void =>
    Match.value(e).pipe(
      Match.discriminatorsExhaustive("_op")({
        And: (and) => {
          walk(and.left);
          walk(and.right);
        },
        Or: (or) => {
          walk(or.left);
          walk(or.right);
        },
        InvalidData: pushLeaf,
        MissingData: pushLeaf,
        Unsupported: pushLeaf,
        SourceUnavailable: pushLeaf,
      }),
    );
  walk(err);
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return "\n" + out.join("\n");
}
