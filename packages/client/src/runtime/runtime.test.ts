import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect, it as itSync } from "vitest";
import {
  MessagesSend,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "@moltzap/protocol";

const RPC_TIMEOUT_MS = 30_000;
const NOT_FOUND_CODE = -32002;

it.effect("tagged errors discriminate by _tag", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(
        new RpcTimeoutError({
          method: MessagesSend.name,
          timeoutMs: RPC_TIMEOUT_MS,
        }),
      ),
    );
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("RpcTimeoutError");
      expect(err.method).toBe(MessagesSend.name);
    } else {
      throw new Error("expected failure");
    }
  }),
);

itSync("RpcServerError preserves wire fields", () => {
  const err = new RpcServerError({
    code: NOT_FOUND_CODE,
    message: "Not found",
  });
  expect(err.code).toBe(NOT_FOUND_CODE);
  expect(err.message).toBe("Not found");
  expect(err.data).toBeUndefined();
});

itSync("NotConnectedError compiles and carries message", () => {
  const err = new NotConnectedError({ message: "socket closed" });
  expect(err.message).toBe("socket closed");
});
