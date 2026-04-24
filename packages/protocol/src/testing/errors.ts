/**
 * Tagged errors surfaced by the `@moltzap/protocol/testing` primitives.
 *
 * Every public `TestClient` / `TestServer` operation returns an
 * `Effect.Effect<T, TestingError, ...>`. Downstream fast-check properties
 * discriminate on `_tag` so shrinks land on a named failure mode rather
 * than an anonymous `unknown`.
 *
 * Invariant I3 (schema is source of truth) lives here: frame-level
 * validation failures raise `FrameSchemaError` on both directions.
 */
import { Data } from "effect";

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

/** A frame read off the wire failed `Value.Check` against its schema. */
export class FrameSchemaError extends Data.TaggedError(
  "TestingFrameSchemaError",
)<{
  readonly direction: "outbound" | "inbound";
  readonly expected: "request" | "response" | "event";
  readonly raw: string;
  readonly reason: string;
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

/** Toxiproxy HTTP API returned a non-2xx, or the control endpoint is down. */
export class ToxicControlError extends Data.TaggedError(
  "TestingToxicControlError",
)<{
  readonly op: "create-proxy" | "delete-proxy" | "add-toxic" | "remove-toxic";
  readonly status: number;
  readonly body: string;
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
