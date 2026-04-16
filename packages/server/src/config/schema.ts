import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// -- Reusable fragments -------------------------------------------------------

function stringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({ type: "string", enum: values });
}

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

const SeedAgentSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const AppRefSchema = Type.Object(
  { manifest: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

// -- Top-level config schema --------------------------------------------------

export const MoltZapConfigSchema = Type.Object(
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

    database: Type.Object(
      { url: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),

    encryption: Type.Object(
      { master_secret: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),

    services: Type.Optional(
      Type.Object(
        {
          users: Type.Optional(ServiceSchema),
          contacts: Type.Optional(ServiceSchema),
          permissions: Type.Optional(ServiceSchema),
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

    seed: Type.Optional(
      Type.Object(
        {
          agents: Type.Optional(Type.Array(SeedAgentSchema)),
          onboarding_message: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),

    apps: Type.Optional(Type.Array(AppRefSchema)),

    log_level: Type.Optional(stringEnum(["debug", "info", "warn", "error"])),
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

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
const validate = ajv.compile(MoltZapConfigSchema);

const EXAMPLES: Record<string, string> = {
  "/database": '{ url: "postgres://..." }',
  "/database/url": '"postgres://user:pass@host:5432/moltzap"',
  "/encryption": '{ master_secret: "a-long-random-string" }',
  "/encryption/master_secret": '"$(openssl rand -hex 32)"',
  "/server/port": "3000",
  "/server/cors_origins": '["https://app.example.com"]',
  "/services/users/type": '"webhook" or "in_process"',
  "/services/users/webhook_url": '"https://hooks.example.com/users"',
  "/log_level": '"info"',
};

function ajvErrorToConfigError(err: {
  instancePath: string;
  message?: string;
  keyword: string;
  params: Record<string, unknown>;
}): ConfigError {
  const path = err.instancePath || "/";

  let problem: string;
  let expected: string;

  switch (err.keyword) {
    case "required": {
      const prop = err.params["missingProperty"] as string;
      const fullPath = path === "/" ? `/${prop}` : `${path}/${prop}`;
      return {
        path: fullPath,
        problem: `Missing required field "${prop}"`,
        expected: `Property "${prop}" must be provided`,
        example: EXAMPLES[fullPath],
      };
    }
    case "additionalProperties": {
      const extra = err.params["additionalProperty"] as string;
      problem = `Unknown field "${extra}"`;
      expected = "Remove this field or check for typos";
      break;
    }
    case "type":
      problem = err.message ?? "Wrong type";
      expected = `Must be ${err.params["type"] as string}`;
      break;
    case "enum":
      problem = "Invalid value";
      expected = `Must be one of: ${(err.params["allowedValues"] as string[]).join(", ")}`;
      break;
    case "minimum":
    case "maximum":
      problem = err.message ?? "Out of range";
      expected = err.message ?? "Value out of allowed range";
      break;
    case "minLength":
      problem = "Value cannot be empty";
      expected = "A non-empty string";
      break;
    case "format":
      problem = `Invalid format (expected ${err.params["format"] as string})`;
      expected = `A valid ${err.params["format"] as string}`;
      break;
    default:
      problem = err.message ?? "Validation failed";
      expected = "See schema for details";
  }

  return { path, problem, expected, example: EXAMPLES[path] };
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
