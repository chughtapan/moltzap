import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// -- Reusable fragments -------------------------------------------------------

const WebhookServiceSchema = Type.Object(
  {
    type: Type.Literal("webhook"),
    webhook_url: Type.String({ format: "uri" }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 100 })),
    callback_token: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const InProcessServiceSchema = Type.Object(
  { type: Type.Literal("in_process") },
  { additionalProperties: false },
);

const ServiceSchema = Type.Union([
  WebhookServiceSchema,
  InProcessServiceSchema,
]);

const AppRefSchema = Type.Object(
  { manifest: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

// -- Top-level config schema --------------------------------------------------

const MoltZapConfigSchema = Type.Object(
  {
    server: Type.Optional(
      Type.Object(
        {
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          cors_origins: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    ),

    database: Type.Optional(
      Type.Object(
        {
          url: Type.Optional(Type.String({ minLength: 1 })),
          data_dir: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),

    encryption: Type.Optional(
      Type.Object(
        { master_secret: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),

    services: Type.Optional(
      Type.Object(
        {
          sessions: Type.Optional(ServiceSchema),
          contacts: Type.Optional(ServiceSchema),
        },
        { additionalProperties: false },
      ),
    ),

    registration: Type.Optional(
      Type.Object(
        { secret: Type.Optional(Type.String({ minLength: 1 })) },
        { additionalProperties: false },
      ),
    ),

    dev_mode: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
          user_id: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),

    apps: Type.Optional(Type.Array(AppRefSchema)),

    log_level: Type.Optional(
      Type.Union([
        Type.Literal("debug"),
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export type MoltZapConfig = Static<typeof MoltZapConfigSchema>;

// -- Validation ---------------------------------------------------------------

export interface ConfigError {
  path: string;
  problem: string;
  expected: string;
  example?: string;
}

interface AjvConfigErrorInput {
  instancePath: string;
  message?: string;
  keyword: string;
  params: Record<string, unknown>;
}

interface ConfigErrorDetail {
  problem: string;
  expected: string;
}

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
const validate = ajv.compile(MoltZapConfigSchema);

const EXAMPLES: Record<string, string> = {
  "/database": '{ url: "postgres://..." }',
  "/database/url": '"postgres://user:pass@host:5432/moltzap"',
  "/encryption": '{ master_secret: "a-long-random-string" }',
  "/encryption/master_secret": '"$(openssl rand -hex 32)"',
  "/server/port": "3000",
  "/server/cors_origins": '["https://app.example.com"]',
  "/services/sessions/type": '"webhook" or "in_process"',
  "/services/sessions/webhook_url": '"https://hooks.example.com/sessions"',
  "/log_level": '"info"',
};

const keywordDetails: Record<
  string,
  (err: AjvConfigErrorInput) => ConfigErrorDetail
> = {
  additionalProperties: additionalPropertyDetail,
  type: typeDetail,
  enum: enumDetail,
  const: constDetail,
  minimum: rangeDetail,
  maximum: rangeDetail,
  minLength: minLengthDetail,
  format: formatDetail,
};

function ajvErrorToConfigError(err: AjvConfigErrorInput): ConfigError {
  const path = normalizeInstancePath(err.instancePath);
  if (err.keyword === "required") return requiredFieldError(err, path);
  const detail = keywordDetails[err.keyword]?.(err) ?? defaultDetail(err);
  return { path, ...detail, example: EXAMPLES[path] };
}

function normalizeInstancePath(path: string): string {
  return path || "/";
}

function requiredFieldError(
  err: AjvConfigErrorInput,
  path: string,
): ConfigError {
  const prop = paramString(err, "missingProperty");
  const fullPath = path === "/" ? `/${prop}` : `${path}/${prop}`;
  return {
    path: fullPath,
    problem: `Missing required field "${prop}"`,
    expected: `Property "${prop}" must be provided`,
    example: EXAMPLES[fullPath],
  };
}

function additionalPropertyDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  const extra = paramString(err, "additionalProperty");
  return {
    problem: `Unknown field "${extra}"`,
    expected: "Remove this field or check for typos",
  };
}

function typeDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  return {
    problem: err.message ?? "Wrong type",
    expected: `Must be ${paramString(err, "type")}`,
  };
}

function enumDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  return {
    problem: "Invalid value",
    expected: `Must be one of: ${paramStringList(err, "allowedValues")}`,
  };
}

function constDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  return {
    problem: "Invalid value",
    expected: `Must be ${JSON.stringify(err.params["allowedValue"])}`,
  };
}

function rangeDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  return {
    problem: err.message ?? "Out of range",
    expected: err.message ?? "Value out of allowed range",
  };
}

function minLengthDetail(): ConfigErrorDetail {
  return {
    problem: "Value cannot be empty",
    expected: "A non-empty string",
  };
}

function formatDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  const format = paramString(err, "format");
  return {
    problem: `Invalid format (expected ${format})`,
    expected: `A valid ${format}`,
  };
}

function defaultDetail(err: AjvConfigErrorInput): ConfigErrorDetail {
  return {
    problem: err.message ?? "Validation failed",
    expected: "See schema for details",
  };
}

function paramString(err: AjvConfigErrorInput, key: string): string {
  return String(err.params[key]);
}

function paramStringList(err: AjvConfigErrorInput, key: string): string {
  const value = err.params[key];
  if (!Array.isArray(value)) return String(value);
  return value.map(String).join(", ");
}

type ValidateResult =
  | { ok: true; config: MoltZapConfig }
  | { ok: false; errors: ConfigError[] };

export function validateConfig(raw: unknown): ValidateResult {
  if (validate(raw)) {
    return { ok: true, config: raw as MoltZapConfig };
  }

  const errors = (validate.errors ?? []).map(ajvErrorToConfigError);

  // Deduplicate by path+problem (union schemas can produce duplicates)
  const seen = new Set<string>();
  const deduped: ConfigError[] = [];
  for (const e of errors) {
    const key = `${e.path}::${e.problem}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(e);
    }
  }

  return { ok: false, errors: deduped };
}

/** Format errors for console output. */
export function formatConfigErrors(errors: ConfigError[]): string {
  return errors
    .map((e) => {
      let line = `  ${e.path}: ${e.problem}\n    Expected: ${e.expected}`;
      if (e.example) line += `\n    Example:  ${e.example}`;
      return line;
    })
    .join("\n\n");
}
