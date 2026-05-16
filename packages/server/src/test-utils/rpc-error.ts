import { Effect } from "effect";
import { expect } from "vitest";
import {
  RpcTimeoutError,
  RpcResponseError,
  TransportClosedError,
  TransportIoError,
  FrameSchemaError,
} from "@moltzap/protocol/testing";

type RpcTestError =
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
  | RpcTimeoutError
  | RpcResponseError;

/**
 * Asserts the RPC effect fails with `RpcServerError(code)` and returns the
 * narrowed error for follow-up assertions. `catchTags` routes by tag name
 * declaratively so callers never reach for `err._tag`.
 */
export const expectRpcFailure = <A, R>(
  effect: Effect.Effect<A, RpcTestError, R>,
  expectedCode: number,
): Effect.Effect<RpcResponseError, never, R> =>
  effect.pipe(
    Effect.flatMap((ok) => failOnSuccess(ok, expectedCode)),
    Effect.catchTags(rpcFailureHandlers(expectedCode)),
  );

function rpcFailureHandlers(expectedCode: number) {
  return {
    TestingTransportClosedError: (err: TransportClosedError) =>
      failUnexpected(expectedCode, `TransportClosedError: ${err.reason}`),
    TestingTransportIoError: (err: TransportIoError) =>
      failUnexpected(expectedCode, `TransportIoError: ${String(err.cause)}`),
    TestingFrameSchemaError: (err: FrameSchemaError) =>
      failUnexpected(expectedCode, `FrameSchemaError: ${err.reason}`),
    TestingRpcTimeoutError: (err: RpcTimeoutError) =>
      failUnexpected(
        expectedCode,
        `RpcTimeoutError on ${err.method} after ${err.timeoutMs}ms`,
      ),
    TestingRpcResponseError: (err: RpcResponseError) =>
      Effect.sync(() => {
        expect(err.code).toBe(expectedCode);
        return err;
      }),
  };
}

function failOnSuccess<A>(
  ok: A,
  expectedCode: number,
): Effect.Effect<RpcResponseError> {
  return failUnexpected(expectedCode, `success: ${JSON.stringify(ok)}`);
}

function failUnexpected(
  expectedCode: number,
  actual: string,
): Effect.Effect<RpcResponseError> {
  return Effect.sync(() => {
    expect.fail(`expected RpcServerError(${expectedCode}), got ${actual}`);
  });
}
