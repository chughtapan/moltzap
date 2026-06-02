import { Cause, Effect, Exit, Option } from "effect";
import { expect, it } from "vitest";
import {
  MessagesSend,
  NotConnectedError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const RPC_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_TAG = "RpcTimeoutError";
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

it("NotConnectedError compiles and carries message", () => {
  const err = new NotConnectedError({ message: SOCKET_CLOSED_MESSAGE });
  expect(err.message).toBe(SOCKET_CLOSED_MESSAGE);
});
