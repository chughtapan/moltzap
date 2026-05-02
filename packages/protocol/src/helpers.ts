import { Type, type TString } from "@sinclair/typebox";

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
