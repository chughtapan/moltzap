import { Schema } from "effect";

/**
 * Optional supplemental fields every wire tagged-error carries: an overriding
 * `message` (the class's static `message` is the default) and a free-form `data`
 * payload. Both are part of the error's wire Schema, so the engine round-trips
 * them when it encodes/decodes the error against a method's per-method error
 * union.
 */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

/**
 * The supplemental-payload type a tagged-error instance accepts at construction:
 * an optional overriding message and optional `data`.
 */
export interface RpcErrorPayload {
  readonly message?: string;
  readonly data?: unknown;
}

/**
 * Build one wire tagged-error class. The class is BOTH the runtime constructor
 * (a `Data.TaggedError`-style failure) AND a `Schema` for the wire `error`
 * union: its `_tag` literal is the union discriminant the `@effect/rpc` engine
 * decodes against, so a method's `Schema.Union(...errors)` picks the exact class
 * by `_tag` with no lookup and no global registry. `_tag` is the wire
 * discriminant — there is no numeric code.
 */
const defineWireError = <
  Tag extends string,
  ExtraFields extends Schema.Struct.Fields,
>(
  tag: Tag,
  staticMessage: string,
  extraFields: ExtraFields,
) =>
  class WireTaggedError extends Schema.TaggedError<WireTaggedError>()(tag, {
    ...errorPayloadFields,
    ...extraFields,
  }) {
    static readonly message = staticMessage;
  };

/** Not authenticated — `network/connect` has not run on this socket. */
export class UnauthorizedError extends defineWireError(
  "Unauthorized",
  "Not authenticated. Send network/connect first.",
  {},
) {}

/** Authenticated but not authorized for this resource. */
export class ForbiddenError extends defineWireError("Forbidden", "Forbidden", {}) {}

/** Resource not found (cross-cutting; domain-specific NotFound errors live with their domain). */
export class NotFoundError extends defineWireError("NotFound", "Not found", {}) {}

/** Conflict on a resource (cross-cutting; e.g., duplicate registration). */
export class ConflictError extends defineWireError("Conflict", "Conflict", {}) {}

/** Boundary validation error — params failed schema validation. */
export class InvalidParamsError extends defineWireError(
  "InvalidParamsError",
  "Invalid params",
  {},
) {}

/**
 * A principal (agent or app) already holds an active connection. The
 * `principal` discriminator names which arm the conflict is on.
 */
export class AlreadyConnected extends defineWireError(
  "AlreadyConnected",
  "Principal already has an active connection. Disconnect the prior session first.",
  { principal: Schema.Literal("agent", "app") },
) {}

/**
 * Inbound frame failed to parse as JSON or did not match the expected shape.
 * Transport-internal — not a wire `error` union member (never crosses the wire
 * as a method failure), so it stays a plain non-schema tagged error.
 */
export class MalformedFrameError extends Schema.TaggedError<MalformedFrameError>()(
  "MalformedFrameError",
  {
    raw: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** The principal-gate error classes every authenticated method's gate can fail with. */
export const principalGateErrorClasses = [
  UnauthorizedError,
  ForbiddenError,
] as const;
