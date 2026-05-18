/**
 * Tagged errors surfaced by the `@moltzap/protocol/testing` primitives.
 *
 * Every public `TestClient` / `TestServer` operation returns an
 * `Effect.Effect&lt;T, TestingError, ...>`. Downstream fast-check properties
 * discriminate on `_tag` so shrinks land on a named failure mode rather
 * than an anonymous `unknown`.
 *
 * Per the Phase 1B reorg, two error fragments live alongside the subsystem
 * that owns them: `FrameSchemaError` co-locates with
 * `./frame-mutator.js`, and `ToxicControlError` co-locates with
 * `../../toxics/errors.js`. The `TestingError` discriminated union keeps
 * exhaustiveness across all seven tags so property `match` calls stay
 * compiler-checked.
 */
import { Data } from "effect";
import { FrameSchemaError } from "./frame-mutator.js";
import { ToxicControlError } from "../../toxics/errors.js";

export { FrameSchemaError, ToxicControlError };

/** Peer closed the underlying WS before a response arrived. */
export class TransportClosedError extends Data.TaggedError(
  "TestingTransportClosedError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly code: number;
  readonly reason: string;
}> {}

/** Underlying transport raised (socket error, DNS, TLS, etc.). */
export class TransportIoError extends Data.TaggedError(
  "TestingTransportIoError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly cause: unknown;
}> {}

/** Wall-clock deadline for a request-id expired before a response. */
export class RpcTimeoutError extends Data.TaggedError(
  "TestingRpcTimeoutError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly timeoutMs: number;
}> {}

/** Server returned a typed `ErrorFrame` for a request. */
export class RpcResponseError extends Data.TaggedError(
  "TestingRpcResponseError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/** Consumer-supplied `realServer()` factory threw or the handle was unusable. */
export class RealServerAcquireError extends Data.TaggedError(
  "TestingRealServerAcquireError",
)<{
  readonly cause: unknown;
}> {}

/**
 * Discriminated union of every error the testing surface can surface.
 * Exhaustiveness over optionality: properties `match` on `_tag` and the
 * compiler flags a missing branch if this union grows.
 */
export type TestingError =
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
  | RpcTimeoutError
  | RpcResponseError
  | ToxicControlError
  | RealServerAcquireError;
