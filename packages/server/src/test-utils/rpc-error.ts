import { Effect } from "effect";
import { expect } from "vitest";
import {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/client";

/**
 * Asserts the RPC effect fails with `RpcServerError(code)` and returns the
 * narrowed error for follow-up assertions. `catchTags` routes by tag name
 * declaratively so callers never reach for `err._tag`.
 */
export const expectRpcFailure = <A, R>(
  effect: Effect.Effect<
    A,
    NotConnectedError | RpcTimeoutError | RpcServerError,
    R
  >,
  expectedCode: number,
): Effect.Effect<RpcServerError, never, R> =>
  effect.pipe(
    Effect.flatMap((ok) =>
      Effect.sync<RpcServerError>(() => {
        expect.fail(
          `expected RpcServerError(${expectedCode}), got success: ${JSON.stringify(ok)}`,
        );
      }),
    ),
    Effect.catchTags({
      NotConnectedError: (err) =>
        Effect.sync<RpcServerError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got NotConnectedError: ${err.message}`,
          );
        }),
      RpcTimeoutError: (err) =>
        Effect.sync<RpcServerError>(() => {
          expect.fail(
            `expected RpcServerError(${expectedCode}), got RpcTimeoutError on ${err.method} after ${err.timeoutMs}ms`,
          );
        }),
      RpcServerError: (err) =>
        Effect.sync(() => {
          expect(err.code).toBe(expectedCode);
          return err;
        }),
    }),
  );
