/**
 * Wire-derived RPC error tags surfaced to callers of an RPC.
 *
 * These tags describe failures at the JSON-RPC transport boundary:
 * - `NotConnectedError` — the socket is not OPEN (or closed mid-call).
 * - `RpcTimeoutError` — no response frame arrived inside the per-call deadline.
 * - `RpcServerError` — the peer returned an `error` response frame.
 *
 * They live in `@moltzap/protocol` because the failure mode is wire-level,
 * not transport-implementation-specific. Both client and server consumers
 * pattern-match on the same `_tag` strings.
 */
import { Data } from "effect";
import type { JsonRpcMethod } from "./wire.js";
import { errorClassFor } from "./wire-errors.js";
import type { RegisteredTaggedError } from "../rpc-registry.js";

/** The socket is not in the OPEN state when an RPC was attempted. */
export class NotConnectedError extends Data.TaggedError("NotConnectedError")<{
  readonly message: string;
}> {}

/** The RPC exceeded the per-call timeout without a response frame. */
export class RpcTimeoutError extends Data.TaggedError("RpcTimeoutError")<{
  readonly method: JsonRpcMethod;
  readonly timeoutMs: number;
}> {}

/** The peer returned an `error` response frame. */
export class RpcServerError extends Data.TaggedError("RpcServerError")<{
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/**
 * The error union a descriptor-driven RPC call can surface: a transport-level
 * `NotConnectedError`, a registered tagged error reconstructed from the wire
 * code, or `RpcServerError` for an unregistered code. The native client's flat
 * engine yields the group's `WireError` envelope on a server-side failure;
 * {@link wireErrorToRpcCallError} reconstructs it onto this union.
 */
export type RpcCallError =
  | NotConnectedError
  | RpcServerError
  | RegisteredTaggedError;

/**
 * Reconstruct a wire-error envelope (`{ code, message, data? }`) into a typed
 * {@link RpcCallError}: a registered tagged error when the code is in the
 * registry (so `catchTag` callers narrow the concrete class), else
 * `RpcServerError`. Forwarding both `message` and `data` keeps the decoded
 * instance reflecting the server's error text + payload.
 */
export function wireErrorToRpcCallError(error: {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}): RpcCallError {
  const cls = errorClassFor(error.code);
  if (cls === undefined) {
    return new RpcServerError({
      code: error.code,
      message: error.message,
      data: error.data,
    });
  }
  // The registry stores the class factory keyed by code; the constructor
  // produces a concrete tagged-error instance whose runtime tag matches one of
  // the `RegisteredTaggedError` union arms. TS cannot see through the open
  // `new (...) => { _tag: string }` factory shape, so the cast bridges the
  // static factory to the closed runtime union.
  return new cls({
    message: error.message,
    data: error.data,
  } as never) as RegisteredTaggedError;
}
