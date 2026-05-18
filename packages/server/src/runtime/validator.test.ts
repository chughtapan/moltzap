import { it as effectIt } from "@effect/vitest";
import * as fc from "fast-check";
import { Cause, Data, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { validateParams } from "./validator.js";
import { InvalidParamsError } from "./errors.js";

const it = effectIt.effect;

const VALID_HELLO = "world";
const INVALID_SHAPE_VALUE = "shape";
const PROPERTY_RUNS = 25;
const HELLO_INPUTS = fc.record({ hello: fc.string() });

interface HelloShape {
  readonly hello: string;
}

class ValidationProbeError extends Data.TaggedError("ValidationProbeError") {}

const acceptAll = (x: unknown): x is HelloShape =>
  hasStringProperty(x, "hello");
const rejectAll = (_x: unknown): _x is never => false;
const throwingValidator = (_x: unknown): _x is never => {
  throw new ValidationProbeError();
};

describe("validateParams accepted input", () => {
  const acceptedInputProperty = fc.property(
    HELLO_INPUTS,
    assertAcceptedInputPreservesIdentity,
  );

  it("passes params through when validator returns true", () =>
    Effect.gen(function* () {
      const input = { hello: VALID_HELLO };
      const result = yield* validateParams<typeof input>(acceptAll, input);
      expect(result).toBe(input);
    }));

  it("property: accepted inputs preserve identity", () =>
    Effect.sync(() => {
      expect.hasAssertions();
      fc.assert(acceptedInputProperty, { numRuns: PROPERTY_RUNS });
    }));
});

describe("validateParams invalid input", () => {
  it("fails with InvalidParamsError when validator returns false", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateParams<unknown>(rejectAll, { any: INVALID_SHAPE_VALUE }),
      );
      expectInvalidParamsFailure(exit);
    }));

  it("fails with InvalidParamsError for null input", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateParams<unknown>(rejectAll, null));
      expectInvalidParamsFailure(exit);
    }));

  it("fails with InvalidParamsError for undefined input", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateParams<unknown>(rejectAll, undefined),
      );
      expectInvalidParamsFailure(exit);
    }));
});

describe("validateParams validator exceptions", () => {
  it("maps a synchronous validator exception to InvalidParamsError", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateParams<unknown>(throwingValidator, { whatever: 1 }),
      );
      expectInvalidParamsFailure(exit);
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

function assertAcceptedInputPreservesIdentity(input: HelloShape) {
  const result = Effect.runSync(validateParams<typeof input>(acceptAll, input));
  expect(result).toBe(input);
}

function failureOption<E>(exit: Exit.Exit<unknown, E>): Option.Option<E> {
  return Exit.match(exit, {
    onFailure: Cause.failureOption,
    onSuccess: () => Option.none(),
  });
}

function expectInvalidParamsFailure<E>(exit: Exit.Exit<unknown, E>) {
  const isInvalidParams = Option.match(failureOption(exit), {
    onNone: () => false,
    onSome: (error) => error instanceof InvalidParamsError,
  });
  expect(isInvalidParams).toBe(true);
}
