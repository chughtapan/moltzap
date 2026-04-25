import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect, it as itSync } from "vitest";
import {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "./errors.js";

it.effect("tagged errors discriminate by _tag", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(
        new RpcTimeoutError({ method: "messages/send", timeoutMs: 30_000 }),
      ),
    );
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const err = exit.cause.error;
      expect(err._tag).toBe("RpcTimeoutError");
      expect(err.method).toBe("messages/send");
    } else {
      throw new Error("expected failure");
    }
  }),
);

itSync("RpcServerError preserves wire fields", () => {
  const err = new RpcServerError({
    code: -32002,
    message: "Not found",
  });
  expect(err.code).toBe(-32002);
  expect(err.message).toBe("Not found");
  expect(err.data).toBeUndefined();
});

itSync("NotConnectedError compiles and carries message", () => {
  const err = new NotConnectedError({ message: "socket closed" });
  expect(err.message).toBe("socket closed");
});
