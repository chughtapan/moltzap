/**
 * Transport-level RPC errors — the failures that originate at the CLIENT
 * transport, not at a method handler. They are NOT wire `error` union members
 * (the server never sends them); the typed client adds them to every per-method
 * call's error channel (`method.ts → ResponseErrorsOf`).
 *
 * Domain/handler failures ride their own `Schema.TaggedError` class on the wire,
 * decoded per-method against that method's `errorSchema` union by `_tag` — no
 * numeric code, no global registry.
 */
import { Data } from "effect";
import type { JsonRpcMethod } from "./method.js";

/** The socket is not in the OPEN state when an RPC was attempted. */
export class NotConnectedError extends Data.TaggedError("NotConnectedError")<{
  readonly message: string;
}> {}

/** The RPC exceeded the per-call timeout without a response frame. */
export class RpcTimeoutError extends Data.TaggedError("RpcTimeoutError")<{
  readonly method: JsonRpcMethod;
  readonly timeoutMs: number;
}> {}
