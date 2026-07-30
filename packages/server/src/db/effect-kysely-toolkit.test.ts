import { it as effectIt } from "@effect/vitest";
import { SqlError } from "@effect/sql/SqlError";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import { ConflictError } from "@moltzap/protocol/rpc";
import {
  catchSqlErrorAsDefect,
  sqlErrorToDefect,
  takeFirstOption,
  takeFirstOrElse,
  takeFirstOrFail,
} from "./effect-kysely-toolkit.js";

const it = effectIt.effect;

const SUCCESS_VALUE = 42;
const TYPED_CONFLICT_MESSAGE = "typed";
const MISSING_ROW_ERROR = "missing";
const FIRST_NUMBER = 7;
const SQL_ERROR_CAUSE = "x";
const SQL_ERROR_MESSAGE = "y";

describe("catchSqlErrorAsDefect defects", () => {
  it("converts SqlError to a Die defect", () =>
    Effect.gen(function* () {
      const err = makeSqlError();
      const program = catchSqlErrorAsDefect(Effect.fail(err));
      expectDefect(yield* Effect.exit(program), err);
    }));

  it("converts NoSuchElementException to a Die", () =>
    Effect.gen(function* () {
      const err = new Cause.NoSuchElementException("no row");
      const program = catchSqlErrorAsDefect(Effect.fail(err));
      expectDefect(yield* Effect.exit(program), err);
    }));
});

describe("catchSqlErrorAsDefect pass-through", () => {
  it("lets tagged-error classes pass through as typed fail", () =>
    Effect.gen(function* () {
      const err = new ConflictError({ message: TYPED_CONFLICT_MESSAGE });
      const program = catchSqlErrorAsDefect(Effect.fail(err));
      const failure = expectFailure(yield* Effect.exit(program));
      expect(failure).toBeInstanceOf(ConflictError);
      expect(
        /* Safe because the test fixture establishes this asserted shape. */
        (failure as ConflictError).message,
      ).toBe(TYPED_CONFLICT_MESSAGE);
    }));

  it("leaves successful programs unchanged", () =>
    Effect.gen(function* () {
      const result = yield* catchSqlErrorAsDefect(
        Effect.succeed(SUCCESS_VALUE),
      );
      expect(result).toBe(SUCCESS_VALUE);
    }));
});

describe("sqlErrorToDefect", () => {
  it("dies on SqlError input", () =>
    Effect.gen(function* () {
      const err = makeSqlError();
      const program = sqlErrorToDefect(Effect.fail(err));
      expectDefect(yield* Effect.exit(program), err);
    }));

  it("passes successful values through", () =>
    Effect.gen(function* () {
      const rows = [1, 2, 3] as const;
      const result = yield* sqlErrorToDefect(Effect.succeed(rows));
      expect(result).toEqual(rows);
    }));
});

describe("takeFirstOption", () => {
  it("returns None for empty input", () =>
    Effect.gen(function* () {
      const result = yield* takeFirstOption(
        Effect.succeed<ReadonlyArray<{ id: string }>>([]),
      );
      expect(Option.isNone(result)).toBe(true);
    }));

  it("returns Some(row) for single-row input", () =>
    Effect.gen(function* () {
      const row = { id: "a" };
      const result = yield* takeFirstOption(
        Effect.succeed<ReadonlyArray<{ id: string }>>([row]),
      );
      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) {
        expect.fail("expected first row");
      }
      expect(result.value).toBe(row);
    }));
});

describe("takeFirstOrElse", () => {
  it("fails with caller's orElse on empty input", () =>
    Effect.gen(function* () {
      const program = takeFirstOrElse(
        Effect.succeed<readonly number[]>([]),
        missingRowError,
      );
      expect(expectFailure(yield* Effect.exit(program))).toBe(
        MISSING_ROW_ERROR,
      );
    }));

  it("returns first row on non-empty input", () =>
    Effect.gen(function* () {
      const result = yield* takeFirstOrElse(
        Effect.succeed<readonly number[]>([FIRST_NUMBER, 8, 9]),
        missingRowError,
      );
      expect(result).toBe(FIRST_NUMBER);
    }));
});

describe("takeFirstOrFail", () => {
  it("fails with NoSuchElementException on empty input", () =>
    Effect.gen(function* () {
      const program = takeFirstOrFail(Effect.succeed<readonly number[]>([]));
      const failure = expectFailure(yield* Effect.exit(program));
      expect(failure).toBeInstanceOf(Cause.NoSuchElementException);
    }));

  it("returns first row on non-empty input", () =>
    Effect.gen(function* () {
      const first = { id: "first" };
      const result = yield* takeFirstOrFail(
        Effect.succeed<ReadonlyArray<{ id: string }>>([
          first,
          { id: "second" },
        ]),
      );
      expect(result).toEqual(first);
    }));
});

function makeSqlError(): SqlError {
  return new SqlError({ cause: SQL_ERROR_CAUSE, message: SQL_ERROR_MESSAGE });
}

function missingRowError(): string {
  return MISSING_ROW_ERROR;
}

function expectDefect(
  exit: Exit.Exit<unknown, unknown>,
  expected: unknown,
): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    expect.fail("expected failure exit");
  }
  const defect = Cause.dieOption(exit.cause);
  expect(Option.isSome(defect)).toBe(true);
  if (Option.isNone(defect)) {
    expect.fail("expected die defect");
  }
  expect(defect.value).toBe(expected);
}

function expectFailure(exit: Exit.Exit<unknown, unknown>): unknown {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    expect.fail("expected failure exit");
  }
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) {
    expect.fail("expected typed failure");
  }
  return failure.value;
}
