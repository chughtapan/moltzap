import { Schema } from "effect";

/** The request representation is not valid for the selected operation. */
export class MalformedRequestError extends Schema.TaggedError<MalformedRequestError>()(
  "MalformedRequestError",
  {},
) {}

/** The request does not prove the required identity or admission authority. */
export class AuthenticationFailedError extends Schema.TaggedError<AuthenticationFailedError>()(
  "AuthenticationFailedError",
  {},
) {}

/** No exact HTTP route owns the request target. */
export class RouteNotFoundError extends Schema.TaggedError<RouteNotFoundError>()(
  "RouteNotFoundError",
  {},
) {}

/** The selected route does not accept the request method. */
export class MethodNotAllowedError extends Schema.TaggedError<MethodNotAllowedError>()(
  "MethodNotAllowedError",
  {},
) {}

/** The request carries a different MoltZap compatibility value. */
export class VersionMismatchError extends Schema.TaggedError<VersionMismatchError>()(
  "VersionMismatchError",
  {},
) {}

/** The received body exceeds the selected route's derived representation cap. */
export class PayloadTooLargeError extends Schema.TaggedError<PayloadTooLargeError>()(
  "PayloadTooLargeError",
  {},
) {}

/** The selected route cannot consume the request content framing. */
export class UnsupportedMediaTypeError extends Schema.TaggedError<UnsupportedMediaTypeError>()(
  "UnsupportedMediaTypeError",
  {},
) {}

/** A finite immediate resource permit is unavailable. */
export class OverloadedError extends Schema.TaggedError<OverloadedError>()(
  "OverloadedError",
  {},
) {}

/** A required service or durable operation cannot currently complete. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "UnavailableError",
  {},
) {}

/** An unexpected implementation failure prevented a closed result. */
export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  "InternalServerError",
  {},
) {}

/** Closed failures represented by the shared HTTP error envelope. */
export type HttpEnvelopeError =
  | MalformedRequestError
  | AuthenticationFailedError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError;

const mappings = Object.freeze({
  MalformedRequestError: { status: 400, code: "malformed" },
  AuthenticationFailedError: { status: 401, code: "authentication_failed" },
  RouteNotFoundError: { status: 404, code: "not_found" },
  MethodNotAllowedError: { status: 405, code: "method_not_allowed" },
  VersionMismatchError: { status: 412, code: "version_mismatch" },
  PayloadTooLargeError: { status: 413, code: "payload_too_large" },
  UnsupportedMediaTypeError: {
    status: 415,
    code: "unsupported_media_type",
  },
  OverloadedError: { status: 429, code: "overloaded" },
  UnavailableError: { status: 503, code: "unavailable" },
  InternalServerError: { status: 500, code: "internal" },
} as const);

/**
 * Private HTTP status and body-code projection for a shared error.
 *
 * @param error Recognized closed HTTP failure.
 * @returns Its exact status and stable body code.
 */
export const httpEnvelope = (
  error: HttpEnvelopeError,
): (typeof mappings)[keyof typeof mappings] => mappings[error._tag];
