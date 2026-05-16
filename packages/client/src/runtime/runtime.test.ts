import { Cause, Effect, Exit, Option } from "effect";
import { expect, it } from "vitest";
import {
  MessagesSend,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const RPC_TIMEOUT_MS = 30_000;
const NOT_FOUND_CODE = -32002;
const RPC_TIMEOUT_TAG = "RpcTimeoutError";
const NOT_FOUND_MESSAGE = "Not found";
const SOCKET_CLOSED_MESSAGE = "socket closed";

it("tagged errors discriminate by _tag", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.fail(
          new RpcTimeoutError({
            method: MessagesSend.name,
            timeoutMs: RPC_TIMEOUT_MS,
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Option.getOrNull(Cause.failureOption(exit.cause));
        expect(err).toBeInstanceOf(RpcTimeoutError);
        if (err instanceof RpcTimeoutError) {
          expect(err._tag).toBe(RPC_TIMEOUT_TAG);
          expect(err.method).toBe(MessagesSend.name);
        }
      }
    }),
  ));

it("RpcServerError preserves wire fields", () => {
  const err = new RpcServerError({
    code: NOT_FOUND_CODE,
    message: NOT_FOUND_MESSAGE,
  });
  expect(err.code).toBe(NOT_FOUND_CODE);
  expect(err.message).toBe(NOT_FOUND_MESSAGE);
  expect(err.data).toBeUndefined();
});

it("NotConnectedError compiles and carries message", () => {
  const err = new NotConnectedError({ message: SOCKET_CLOSED_MESSAGE });
  expect(err.message).toBe(SOCKET_CLOSED_MESSAGE);
});
