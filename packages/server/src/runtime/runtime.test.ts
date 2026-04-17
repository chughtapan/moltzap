import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import { validateParams } from "./validator.js";
import { InvalidParamsError, RpcFailure } from "./errors.js";

interface Shape {
  name: string;
}
const accept = (x: unknown): boolean =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Record<string, unknown>)["name"] === "string";

it.effect("validateParams succeeds with narrowed value", () =>
  Effect.gen(function* () {
    const result = yield* validateParams<Shape>(accept, { name: "ok" });
    expect(result.name).toBe("ok");
  }),
);

it.effect("validateParams fails with InvalidParamsError", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(validateParams<Shape>(accept, {}));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : null;
      expect(error).toBeInstanceOf(InvalidParamsError);
    }
  }),
);

it.effect("RpcFailure carries code, message, and optional data", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(
        new RpcFailure({ code: -32000, message: "nope", data: { why: "x" } }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.code).toBe(-32000);
      expect(exit.cause.error.message).toBe("nope");
      expect(exit.cause.error.data).toEqual({ why: "x" });
    }
  }),
);
