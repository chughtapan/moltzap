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
 * Asserts the RPC effect fails with a wire `error` carrying `expectedTag` and
 * returns the narrowed error for follow-up assertions. `catchTags` routes by
 * tag name declaratively so callers never reach for `err._tag`.
 */
export const expectRpcFailure = <A, R>(
  effect: Effect.Effect<A, RpcTestError, R>,
  expectedTag: string,
): Effect.Effect<RpcResponseError, never, R> =>
  effect.pipe(
    Effect.flatMap((ok) => failOnSuccess(ok, expectedTag)),
    Effect.catchTags(rpcFailureHandlers(expectedTag)),
  );

function rpcFailureHandlers(expectedTag: string) {
  return {
    TestingTransportClosedError: (err: TransportClosedError) =>
      failUnexpected(expectedTag, `TransportClosedError: ${err.reason}`),
    TestingTransportIoError: (err: TransportIoError) =>
      failUnexpected(expectedTag, `TransportIoError: ${String(err.cause)}`),
    TestingFrameSchemaError: (err: FrameSchemaError) =>
      failUnexpected(expectedTag, `FrameSchemaError: ${err.reason}`),
    TestingRpcTimeoutError: (err: RpcTimeoutError) =>
      failUnexpected(
        expectedTag,
        `RpcTimeoutError on ${err.method} after ${err.timeoutMs}ms`,
      ),
    TestingRpcResponseError: (err: RpcResponseError) =>
      Effect.sync(() => {
        expect(err.tag).toBe(expectedTag);
        return err;
      }),
  };
}

function failOnSuccess<A>(
  ok: A,
  expectedTag: string,
): Effect.Effect<RpcResponseError> {
  return failUnexpected(expectedTag, `success: ${JSON.stringify(ok)}`);
}

function failUnexpected(
  expectedTag: string,
  actual: string,
): Effect.Effect<RpcResponseError> {
  return Effect.sync(() => {
    expect.fail(`expected wire error tag ${expectedTag}, got ${actual}`);
  });
}
