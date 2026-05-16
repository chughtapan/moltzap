import { it as effectIt } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { ConflictError } from "@moltzap/protocol";
import { wireErrorFromInstance } from "@moltzap/protocol/testing";
import { validateParams } from "./validator.js";
import { InvalidParamsError } from "./errors.js";

const it = effectIt.effect;

const CONFLICT_ERROR_CODE = -32003;
const VALID_NAME = "ok";
const CONFLICT_MESSAGE = "nope";
const CONFLICT_DATA = { why: "x" } as const;

interface Shape {
  name: string;
}
const accept = (x: unknown): x is Shape => hasStringProperty(x, "name");

describe("runtime helpers", () => {
  it("validateParams succeeds with narrowed value", () =>
    Effect.gen(function* () {
      const result = yield* validateParams<Shape>(accept, { name: VALID_NAME });
      expect(result.name).toBe(VALID_NAME);
    }));

  it("validateParams fails with InvalidParamsError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateParams<Shape>(accept, {}));
      expectFailureInstance(exit, InvalidParamsError);
    }));

  it("ConflictError carries message and optional data", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.fail(
          new ConflictError({
            message: CONFLICT_MESSAGE,
            data: CONFLICT_DATA,
          }),
        ),
      );
      const wire = Option.match(failureOption(exit), {
        onNone: () => undefined,
        onSome: wireErrorFromInstance,
      });
      expect(wire?.code).toBe(CONFLICT_ERROR_CODE);
      expect(wire?.message).toBe(CONFLICT_MESSAGE);
      expect(wire?.data).toEqual(CONFLICT_DATA);
    }));
});

function hasStringProperty<Key extends string>(
  value: unknown,
  key: Key,
): value is { readonly [Property in Key]: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, key) === "string"
  );
}

function failureOption<E>(exit: Exit.Exit<unknown, E>): Option.Option<E> {
  return Exit.match(exit, {
    onFailure: Cause.failureOption,
    onSuccess: () => Option.none(),
  });
}

function expectFailureInstance<E>(
  exit: Exit.Exit<unknown, E>,
  expectedClass: abstract new (...args: never[]) => E,
) {
  const matchesExpectedClass = Option.match(failureOption(exit), {
    onNone: () => false,
    onSome: (error) => error instanceof expectedClass,
  });
  expect(matchesExpectedClass).toBe(true);
}
