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
