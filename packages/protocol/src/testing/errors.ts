import { Data } from "effect";
import { ToxicControlError } from "./toxics/errors.js";

/** Re-exports the public API from `current module`. */
export { ToxicControlError };

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

/** Wall-clock deadline for a request expired before a response. */
export class RpcTimeoutError extends Data.TaggedError(
  "TestingRpcTimeoutError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly timeoutMs: number;
}> {}

/** Server returned a typed error for a request. */
export class RpcResponseError extends Data.TaggedError(
  "TestingRpcResponseError",
)<{
  readonly method: string;
  readonly requestId: string;
  readonly tag: string;
  readonly message: string;
  readonly data?: unknown;
}> {}

/** Consumer-supplied real-server factory threw or returned an unusable handle. */
export class RealServerAcquireError extends Data.TaggedError(
  "TestingRealServerAcquireError",
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

/** Represents testing error conditions. */
export type TestingError =
  | TransportClosedError
  | TransportIoError
  | RpcTimeoutError
  | RpcResponseError
  | ToxicControlError
  | RealServerAcquireError;
