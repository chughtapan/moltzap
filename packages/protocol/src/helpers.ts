import { FormatRegistry, Type, type TString } from "@sinclair/typebox";

/**
 * Register the string formats this protocol uses with TypeBox's
 * `FormatRegistry` as a side effect at module load. Without this,
 * `Value.Decode` against any schema that uses `format: "uuid"` (and friends)
 * fails with `Unknown format uuid` and every frame is rejected — see #370.
 *
 * Registering here makes downstream consumers correct by construction:
 * importing anything from `@moltzap/protocol` registers the formats, even
 * via dynamic-import paths that never reach a bin entrypoint.
 *
 * `FormatRegistry` is a process-global, so we gate on `Has(...)` to avoid
 * clobbering a consumer-provided stricter validator that ran before us.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shape filter for RFC 3339 / ISO 8601. We pair it with `Date.parse` so
// values like "2026-99-99T99:99:99Z" — shape-valid but semantically
// impossible — also reject.
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Liberal URI matcher: scheme + ":" + non-whitespace remainder. Tighter
// validation (e.g., authority parsing) lives in the consumer if needed.
const URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set(
    "uuid",
    (value) => typeof value === "string" && UUID_RE.test(value),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  });
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set(
    "uri",
    (value) => typeof value === "string" && URI_RE.test(value),
  );
}

/**
 * Creates a string enum schema without producing anyOf (which some validators reject).
 * Uses Type.String + enum constraint (Kind="String") so TypeBox's Value.Decode
 * visitor handles the node — Type.Unsafe has no Kind tag and trips
 * `ValueCheckUnknownTypeError: Unknown type` on consumer-side decoders.
 * Matches OpenClaw's stringEnum pattern.
 */
export function stringEnum<T extends string[]>(values: [...T]) {
  return Type.String({ enum: values }) as TString & { static: T[number] };
}

/**
 * Branded UUID string type for TypeBox schemas.
 * Usage: brandedId("UserId") produces a string schema with format: "uuid"
 */
export function brandedId(brand: string) {
  return Type.String({ format: "uuid", description: `Branded ${brand}` });
}

/**
 * ISO 8601 datetime string schema.
 */
export const DateTimeString = Type.String({ format: "date-time" });

/**
 * Construct a typed EventFrame. Eliminates manual `{ jsonrpc: "2.0", type: "event" }` boilerplate.
 */
export function eventFrame(
  event: string,
  data?: Record<string, unknown>,
): {
  jsonrpc: "2.0";
  type: "event";
  event: string;
  data?: Record<string, unknown>;
} {
  return {
    jsonrpc: "2.0",
    type: "event",
    event,
    ...(data !== undefined ? { data } : {}),
  };
}

/**
 * Construct a typed ResponseFrame literal. Centralizes the
 * `{ jsonrpc, type: "response", direction, id, result | error }` shape
 * so c2s and s2c response sites do not drift on field order, escaping,
 * or `direction` typing. Mirrors `eventFrame()` for the symmetric
 * surface.
 *
 * Pass `{ result }` for success, `{ error }` for failure; the schema
 * permits both fields to be `Type.Optional` but exactly one of them is
 * present in any well-formed reply, so the discriminated body argument
 * keeps the type system aligned with the wire contract.
 */
export type ResponseFrameDirection = "c2s" | "s2c";
export type ResponseFrameError = {
  code: number;
  message: string;
  data?: unknown;
};
export type ResponseFrameBody =
  | { result: unknown }
  | { error: ResponseFrameError };

export function responseFrame(
  direction: ResponseFrameDirection,
  id: string,
  body: ResponseFrameBody,
): {
  jsonrpc: "2.0";
  type: "response";
  direction: ResponseFrameDirection;
  id: string;
  result?: unknown;
  error?: ResponseFrameError;
} {
  return {
    jsonrpc: "2.0",
    type: "response",
    direction,
    id,
    ...body,
  };
}
