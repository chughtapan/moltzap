import { Type } from "@sinclair/typebox";

/**
 * Creates a string enum schema without producing anyOf (which some validators reject).
 * Matches OpenClaw's stringEnum pattern.
 */
export function stringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({ type: "string", enum: values });
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
