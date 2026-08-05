import { Schema } from "effect";

/**
 * Optional supplemental fields every wire tagged-error carries: an overriding
 * `message` (the class's static `message` is the default) and a free-form `data`
 * payload. Both are part of the error's wire Schema, so the engine round-trips
 * them when it encodes/decodes the error against a method's per-method error
 * union.
 *
 * Each wire error class is declared inline (extending `Schema.TaggedError`
 * directly) rather than through a factory: a factory return type leaks the
 * Schema's private `TypeId`/`RefineSchemaId` and is not a nameable base class.
 * The class is BOTH the runtime constructor AND a `Schema` for the wire `error`
 * union — its `_tag` literal is the union discriminant the `@effect/rpc` engine
 * decodes against, so a method's `Schema.Union(...errors)` picks the exact class
 * by `_tag` with no lookup and no global registry. There is no numeric code.
 */
export const errorPayloadFields = {
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

/** Not authenticated — `agent/network/connect` has not run on this socket. */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "Unauthorized",
  errorPayloadFields,
) {
  static readonly message =
    "Not authenticated. Send agent/network/connect first.";
}

/** Authenticated but not authorized for this resource. */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()(
  "Forbidden",
  errorPayloadFields,
) {
  static readonly message = "Forbidden";
}

/** Resource not found (cross-cutting; domain-specific NotFound errors live with their domain). */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFound",
  errorPayloadFields,
) {
  static readonly message = "Not found";
}

/** Conflict on a resource (cross-cutting; e.g., duplicate registration). */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Conflict",
  errorPayloadFields,
) {
  static readonly message = "Conflict";
}

/** Boundary validation error — params failed schema validation. */
export class InvalidParamsError extends Schema.TaggedError<InvalidParamsError>()(
  "InvalidParamsError",
  errorPayloadFields,
) {
  static readonly message = "Invalid params";
}

/**
 * A principal (agent or app) already holds an active connection. The
 * `principal` discriminator names which arm the conflict is on.
 */
export class AlreadyConnected extends Schema.TaggedError<AlreadyConnected>()(
  "AlreadyConnected",
  { ...errorPayloadFields, principal: Schema.Literal("agent", "app") },
) {
  static readonly message =
    "Principal already has an active connection. Disconnect the prior session first.";
}

/** The principal-gate error classes every authenticated method's gate can fail with. */
export const principalGateErrorClasses = [
  UnauthorizedError,
  ForbiddenError,
] as const;
