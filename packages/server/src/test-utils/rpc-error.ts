import { Effect } from "effect";
import { expect } from "vitest";
import {
  RpcTimeoutError,
  RpcResponseError,
  TransportClosedError,
  TransportIoError,
  FrameSchemaError,
} from "@moltzap/protocol/testing";

/**
 * Asserts the RPC effect fails with `RpcServerError(code)` and returns the
 * narrowed error for follow-up assertions. `catchTags` routes by tag name
 * declaratively so callers never reach for `err._tag`.
 */
export const expectRpcFailure = <A, R>(
  effect: Effect.Effect<
    A,
    | TransportClosedError
    | TransportIoError
    | FrameSchemaError
    | RpcTimeoutError
    | RpcResponseError,
    R
  >,
  expectedCode: number,
): Effect.Effect<RpcResponseError, never, R> =>
  effect.pipe(
    Effect.flatMap((ok) =>
      Effect.sync<RpcResponseError>(() => {
        expect.fail(
          `expected RpcServerError(${expectedCode}), got success: ${JSON.stringify(ok)}`,
        );
      }),
    ),
    Effect.catchTags({
      TestingTransportClosedError: (err) =>
        Effect.sync<RpcResponseError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got TransportClosedError: ${err.reason}`,
          );
        }),
      TestingTransportIoError: (err) =>
        Effect.sync<RpcResponseError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got TransportIoError: ${String(err.cause)}`,
          );
        }),
      TestingFrameSchemaError: (err) =>
        Effect.sync<RpcResponseError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got FrameSchemaError: ${err.reason}`,
          );
        }),
      TestingRpcTimeoutError: (err) =>
        Effect.sync<RpcResponseError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got RpcTimeoutError on ${err.method} after ${err.timeoutMs}ms`,
          );
        }),
      TestingRpcResponseError: (err) =>
        Effect.sync(() => {
          expect(err.code).toBe(expectedCode);
          return err;
        }),
    }),
  );
