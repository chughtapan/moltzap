/**
 * Load MoltZap configuration from a YAML file.
 *
 * Failures surface as a typed `ConfigLoadError` in the Effect error channel —
 * nothing is thrown. Consumers run via `Effect.runPromise` (or
 * `runPromiseExit` to inspect failures) and decide how to react.
 */

import { FileSystem, Path } from "@effect/platform";
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

const dirnameEffect = (
  pathName: string,
): Effect.Effect<string, never, Path.Path> =>
  Path.Path.pipe(Effect.map((path) => path.dirname(pathName)));

const resolveConfigPath = (
  path: string | undefined,
  processEnv: ProcessEnvSnapshot | undefined,
) => path ?? readEnvValue(processEnv, "MOLTZAP_CONFIG") ?? "moltzap.yaml";

function readConfigFile(
  configPath: string,
): Effect.Effect<string, ConfigLoadError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(configPath, "utf-8")),
    Effect.catchTags({
      BadArgument: (cause) => Effect.fail(readConfigError(configPath, cause)),
      SystemError: (cause) => Effect.fail(readConfigError(configPath, cause)),
    }),
    Effect.withSpan("readConfigFile"),
  );
}

function readConfigError(
  configPath: string,
  cause: { readonly message: string },
) {
  return new ConfigLoadError({
    kind: "read",
    path: configPath,
    message: `Cannot read config file "${configPath}": ${cause.message}`,
    cause,
  });
}

function parseYamlDocument(
  raw: string,
  configPath: string,
): Effect.Effect<unknown, ConfigLoadError> {
  return Effect.try({
    try: (): unknown => parseYaml(raw),
    catch: (cause) =>
      new ConfigLoadError({
        kind: "yaml",
        path: configPath,
        message: `Invalid YAML in "${configPath}": ${(cause as Error).message}`,
        cause,
      }),
  }).pipe(Effect.withSpan("parseYamlDocument"));
}

function decodeYamlMapping(
  parsed: unknown,
  configPath: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ConfigLoadError> {
  return Either.match(decodeYamlDocument(parsed), {
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
  }).pipe(Effect.withSpan("decodeYamlMapping"));
}

function validateYamlConfig(
  value: unknown,
  configPath: string,
): Effect.Effect<unknown, ConfigLoadError> {
  const schemaResult = validateConfig(value);
  if (schemaResult.ok) {
    return Effect.succeed(value);
  }
  return Effect.fail(
    new ConfigLoadError({
      kind: "validation",
      path: configPath,
      message: `Invalid config in "${configPath}":\n${formatConfigErrors(schemaResult.errors)}`,
    }),
  );
}

function decodeMoltZapConfig(
  value: unknown,
  configPath: string,
): Effect.Effect<MoltZapAppConfig, ConfigLoadError> {
  return MoltZapConfig.pipe(
    Effect.withConfigProvider(ConfigProvider.fromJson(value ?? {})),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (configError) =>
          Effect.fail(configValidationError(configPath, configError)),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
    Effect.withSpan("decodeMoltZapConfig"),
  );
}

function configValidationError(configPath: string, configError: ConfigError) {
  return new ConfigLoadError({
    kind: "validation",
    path: configPath,
    message: `Invalid config in "${configPath}": ${formatConfigError(configError)}`,
    configError,
  });
}

function resolveConfigDir(
  configPath: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.realPath(configPath)),
    Effect.flatMap(dirnameEffect),
    Effect.catchAll((cause) =>
      Effect.logWarning("Failed to resolve config path symlink:", cause).pipe(
        Effect.flatMap(() => dirnameEffect(configPath)),
      ),
    ),
    Effect.withSpan("resolveConfigDir"),
  );
}

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
): Effect.Effect<
  MoltZapAppConfig & { _configDir: string },
  ConfigLoadError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const configPath = resolveConfigPath(path, processEnv);
    const raw = yield* readConfigFile(configPath);
    const parsed = yield* parseYamlDocument(raw, configPath);
    const decoded = yield* decodeYamlMapping(parsed, configPath);
    const interpolated = yield* interpolateEnvVars(
      decoded,
      configPath,
      processEnv,
    );
    const validated = yield* validateYamlConfig(interpolated, configPath);
    const value = yield* decodeMoltZapConfig(validated, configPath);
    const configDir = yield* resolveConfigDir(configPath);

    return { ...value, _configDir: configDir };
  }).pipe(Effect.withSpan("loadConfigFromFile"));

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
