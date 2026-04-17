import { Data } from "effect";
import { ErrorCodes } from "@moltzap/protocol";

/**
 * Typed RPC failure. Produce via `Effect.fail(new RpcFailure({...}))` in
 * handlers and services; the router maps it to a `ResponseFrame.error` at
 * the wire edge. `code` matches `@moltzap/protocol`'s `ErrorCodes`.
 */
export class RpcFailure extends Data.TaggedError("RpcFailure")<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/**
 * Named factories for the most common RpcFailure shapes. Use these instead
 * of `new RpcFailure({ code: ErrorCodes.X, message })` at call sites where
 * the code is implied by the helper name — it eliminates code/message drift
 * (e.g. the same "not found" message paired with `Forbidden` code).
 */
export const notFound = (message: string): RpcFailure =>
  new RpcFailure({ code: ErrorCodes.NotFound, message });

export const forbidden = (message: string): RpcFailure =>
  new RpcFailure({ code: ErrorCodes.Forbidden, message });

export const unauthorized = (message: string): RpcFailure =>
  new RpcFailure({ code: ErrorCodes.Unauthorized, message });

export const invalidParams = (message: string): RpcFailure =>
  new RpcFailure({ code: ErrorCodes.InvalidParams, message });

export const conflict = (message: string, data?: unknown): RpcFailure =>
  new RpcFailure({
    code: ErrorCodes.Conflict,
    message,
    ...(data !== undefined ? { data } : {}),
  });

export const internalError = (message: string): RpcFailure =>
  new RpcFailure({ code: ErrorCodes.InternalError, message });

/** Boundary validation error — raised when an AJV validator rejects `params`. */
export class InvalidParamsError extends Data.TaggedError("InvalidParamsError")<{
  readonly message: string;
}> {
  static readonly code = ErrorCodes.InvalidParams;
}

/** Raised when `requiresActive` handlers run against a non-active agent. */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
}> {
  static readonly code = ErrorCodes.Forbidden;
}
