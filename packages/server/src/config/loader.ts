import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  validateConfig,
  formatConfigErrors,
  type MoltZapConfig,
} from "./schema.js";

/** Interpolate `${ENV_VAR}` references in string values throughout a parsed object. */
function interpolateEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new ConfigLoadError(
          `Environment variable "${varName}" referenced in config is not set`,
        );
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars);
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = interpolateEnvVars(val);
    }
    return out;
  }
  return obj;
}

export function loadConfigFromFile(path?: string): MoltZapConfig {
  const configPath = path ?? process.env["MOLTZAP_CONFIG"] ?? "moltzap.yaml";

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new ConfigLoadError(
      `Cannot read config file "${configPath}": ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigLoadError(
      `Invalid YAML in "${configPath}": ${(err as Error).message}`,
    );
  }

  const interpolated = interpolateEnvVars(parsed);

  const result = validateConfig(interpolated);
  if (!result.ok) {
    const formatted = formatConfigErrors(result.errors);
    throw new ConfigLoadError(
      `Invalid config in "${configPath}":\n\n${formatted}`,
      result.errors,
    );
  }

  return result.config;
}

export class ConfigLoadError extends Error {
  constructor(
    message: string,
    public readonly errors?: Array<{
      path: string;
      problem: string;
      expected: string;
      example?: string;
    }>,
  ) {
    super(message);
    this.name = "ConfigLoadError";
  }
}
