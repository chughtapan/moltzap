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
import { Schema } from "effect";

/** The socket is not in the OPEN state when an RPC was attempted. */
export class NotConnectedError extends Schema.TaggedError<NotConnectedError>()(
  "NotConnectedError",
  { message: Schema.String },
) {}

/** The RPC exceeded the per-call timeout without a response frame. */
export class RpcTimeoutError extends Schema.TaggedError<RpcTimeoutError>()(
  "RpcTimeoutError",
  {
    method: Schema.String,
    timeoutMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  },
) {}
