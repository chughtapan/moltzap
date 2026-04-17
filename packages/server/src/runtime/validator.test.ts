import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect, it as vitestIt } from "vitest";
import { validateParams } from "./validator.js";
import { InvalidParamsError } from "./errors.js";

// Trivial validators — each exercises one branch of `validateParams`.
const acceptAll = (_x: unknown): _x is unknown => true;
const rejectAll = (_x: unknown): _x is unknown => false;
const throwingValidator = (_x: unknown): _x is unknown => {
  throw new Error("validator blew up");
};

it.effect("passes params through when validator returns true", () =>
  Effect.gen(function* () {
    const input = { hello: "world" };
    const result = yield* validateParams<typeof input>(acceptAll, input);
    // Preserves identity — no cloning / normalization.
    expect(result).toBe(input);
  }),
);

it.effect("fails with InvalidParamsError when validator returns false", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      validateParams<unknown>(rejectAll, { any: "shape" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(InvalidParamsError);
    } else {
      throw new Error("expected typed Fail");
    }
  }),
);

it.effect("fails with InvalidParamsError for null input", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(validateParams<unknown>(rejectAll, null));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(InvalidParamsError);
    }
  }),
);

it.effect("fails with InvalidParamsError for undefined input", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      validateParams<unknown>(rejectAll, undefined),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(InvalidParamsError);
    }
  }),
);

vitestIt(
  "treats a synchronous throw from the validator as an uncaught exception",
  () => {
    // Current behavior: `validateParams` calls `validator(input)` eagerly
    // at the top of the function body, BEFORE constructing any Effect.
    // A synchronous throw therefore escapes the caller as a plain JS
    // exception — it is NOT lifted into the Effect error channel, and
    // not wrapped as a defect either. We intentionally document this:
    // handlers pass AJV-compiled validators (which don't throw on bad
    // input — they return false), so wrapping in try/catch would be
    // dead defensive code. If the policy ever changes to "wrap throws
    // as defects," this test should switch to the Effect.exit shape.
    expect(() =>
      validateParams<unknown>(throwingValidator, { whatever: 1 }),
    ).toThrow("validator blew up");

    // Sanity: once lifted into an Effect.sync wrapper, the throw DOES
    // become a defect. This is how a caller could opt into defect
    // semantics if they wanted — not what the current API does.
    const wrapped = Effect.suspend(() =>
      validateParams<unknown>(throwingValidator, { whatever: 1 }),
    );
    const exit = Effect.runSyncExit(wrapped);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause._tag).toBe("Die");
    }
  },
);
