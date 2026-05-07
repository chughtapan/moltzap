import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import { ConflictError } from "@moltzap/protocol";
import { wireErrorFromInstance } from "@moltzap/protocol/testing";
import { validateParams } from "./validator.js";
import { InvalidParamsError } from "./errors.js";

interface Shape {
  name: string;
}
const accept = (x: unknown): x is Shape =>
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

it.effect("ConflictError carries message and optional data", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.fail(new ConflictError({ message: "nope", data: { why: "x" } })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      const wire = wireErrorFromInstance(exit.cause.error);
      expect(wire?.code).toBe(-32003);
      expect(wire?.message).toBe("nope");
      expect(wire?.data).toEqual({ why: "x" });
    }
  }),
);
