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
import { Data, Effect, ConfigProvider, Match } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { MoltZapConfig, type MoltZapAppConfig } from "./effect-config.js";

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

/** Interpolate `${ENV_VAR}` references in string values throughout a parsed object. */
function interpolateEnvVars(
  obj: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: ConfigLoadError } {
  if (typeof obj === "string") {
    let missing: string | null = null;
    const replaced = obj.replace(
      /\$\{([^}]+)\}/g,
      (_match, varName: string) => {
        const value = process.env[varName];
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
      return {
        ok: false,
        error: new ConfigLoadError({
          kind: "env",
          path,
          message: `Missing env var "${missing}" referenced in "${path}"`,
        }),
      };
    }
    return { ok: true, value: replaced };
  }
  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    for (const v of obj) {
      const r = interpolateEnvVars(v, path);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      const r = interpolateEnvVars(val, path);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value: obj };
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
): Effect.Effect<MoltZapAppConfig & { _configDir: string }, ConfigLoadError> =>
  Effect.gen(function* () {
    const configPath = path ?? process.env["MOLTZAP_CONFIG"] ?? "moltzap.yaml";

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
      try: () => parseYaml(raw) as unknown,
      catch: (cause) =>
        new ConfigLoadError({
          kind: "yaml",
          path: configPath,
          message: `Invalid YAML in "${configPath}": ${(cause as Error).message}`,
          cause,
        }),
    });

    const interp = interpolateEnvVars(parsed, configPath);
    if (!interp.ok) return yield* Effect.fail(interp.error);

    // `fromJson` walks the nested object and produces flat paths that
    // `Config.all(...)` / `Config.nested(...)` / `Config.array(...)` consume.
    const provider = ConfigProvider.fromJson(interp.value ?? {});

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
