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
import { Data, Effect, ConfigProvider, Either, Match, Schema } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { MoltZapConfig, type MoltZapAppConfig } from "./effect-config.js";

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
 * Top-level fields that used to be valid in `moltzap.yaml` but have
 * been removed. Effect's `Config.all` ignores unknown keys, so an
 * operator with a stale field would boot silently with the field's
 * intent lost. Surface it as a hard error with migration guidance
 * instead.
 */
const RETIRED_TOP_LEVEL_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly guidance: string;
}> = [
  {
    key: "seed",
    guidance:
      'remove this block. Boot-time agent seeding was dropped; mint your first agent via POST /api/v1/admin/register-agent (idempotent) or POST /api/v1/auth/register. See README "Get Started" / CHANGELOG.',
  },
];

function findRetiredTopLevelField(
  obj: unknown,
): { readonly key: string; readonly guidance: string } | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  // YAML decode-and-interpolate (above) hands us an unknown record; the
  // YamlDocumentSchema at the boundary already constrained shape to
  // `Record<string, Unknown>`, so the field-presence check via `in`
  // operator is the narrow contract we need.
  // #ignore-sloppy-code-next-line[record-cast]: yaml document is already validated as a string-keyed record at the loader boundary
  const record = obj as Record<string, unknown>;
  for (const entry of RETIRED_TOP_LEVEL_FIELDS) {
    if (entry.key in record) return entry;
  }
  return null;
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
      try: (): unknown => parseYaml(raw),
      catch: (cause) =>
        new ConfigLoadError({
          kind: "yaml",
          path: configPath,
          message: `Invalid YAML in "${configPath}": ${(cause as Error).message}`,
          cause,
        }),
    });

    const decoded = decodeYamlDocument(parsed);
    if (Either.isLeft(decoded)) {
      return yield* Effect.fail(
        new ConfigLoadError({
          kind: "yaml",
          path: configPath,
          message: `Invalid YAML in "${configPath}": top-level value must be a mapping (${decoded.left.message})`,
          cause: decoded.left,
        }),
      );
    }

    const interp = interpolateEnvVars(decoded.right, configPath);
    if (!interp.ok) return yield* Effect.fail(interp.error);

    // Reject retired top-level fields up-front. Effect's `Config.all`
    // silently ignores unknown keys, so without this check a stale
    // `seed:` block in a pre-existing moltzap.yaml would boot
    // successfully and silently no-op (the seed task that consumed
    // it is gone). Surface the migration explicitly instead.
    const retiredField = findRetiredTopLevelField(interp.value);
    if (retiredField !== null) {
      return yield* Effect.fail(
        new ConfigLoadError({
          kind: "validation",
          path: configPath,
          message: `Invalid config in "${configPath}": retired field "${retiredField.key}" — ${retiredField.guidance}`,
        }),
      );
    }

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
