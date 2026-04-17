import { it } from "@effect/vitest";
import { SqlError } from "@effect/sql/SqlError";
import { Cause, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import {
  catchSqlErrorAsDefect,
  sqlErrorToDefect,
  takeFirstOption,
  takeFirstOrElse,
  takeFirstOrFail,
} from "./effect-kysely-toolkit.js";
import { RpcFailure } from "../runtime/index.js";

// ── catchSqlErrorAsDefect ───────────────────────────────────────────────

it.effect("catchSqlErrorAsDefect converts SqlError to a Die defect", () =>
  Effect.gen(function* () {
    const err = new SqlError({ cause: new Error("x"), message: "y" });
    const program = catchSqlErrorAsDefect(
      Effect.fail(err) as Effect.Effect<never, SqlError>,
    );
    const exit = yield* Effect.exit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause._tag).toBe("Die");
      // The original SqlError is preserved inside the defect.
      const defect = Cause.dieOption(exit.cause);
      expect(Option.isSome(defect)).toBe(true);
      if (Option.isSome(defect)) {
        expect(defect.value).toBe(err);
      }
    }
  }),
);

it.effect(
  "catchSqlErrorAsDefect converts NoSuchElementException to a Die",
  () =>
    Effect.gen(function* () {
      const err = new Cause.NoSuchElementException("no row");
      const program = catchSqlErrorAsDefect(
        Effect.fail(err) as Effect.Effect<never, Cause.NoSuchElementException>,
      );
      const exit = yield* Effect.exit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause._tag).toBe("Die");
        const defect = Cause.dieOption(exit.cause);
        expect(Option.isSome(defect)).toBe(true);
        if (Option.isSome(defect)) {
          expect(defect.value).toBe(err);
        }
      }
    }),
);

it.effect(
  "catchSqlErrorAsDefect lets RpcFailure pass through as typed fail",
  () =>
    Effect.gen(function* () {
      const err = new RpcFailure({ code: -32001, message: "typed" });
      const program = catchSqlErrorAsDefect(
        Effect.fail(err) as Effect.Effect<never, RpcFailure>,
      );
      const exit = yield* Effect.exit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(RpcFailure);
        expect((exit.cause.error as RpcFailure).code).toBe(-32001);
      } else {
        throw new Error("expected typed Fail, not Die");
      }
    }),
);

it.effect("catchSqlErrorAsDefect leaves successful programs unchanged", () =>
  Effect.gen(function* () {
    const result = yield* catchSqlErrorAsDefect(Effect.succeed(42));
    expect(result).toBe(42);
  }),
);

// ── sqlErrorToDefect (alias) ────────────────────────────────────────────

it.effect("sqlErrorToDefect dies on SqlError input", () =>
  Effect.gen(function* () {
    const err = new SqlError({ cause: new Error("x"), message: "y" });
    const program = sqlErrorToDefect(Effect.fail(err));
    const exit = yield* Effect.exit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause._tag).toBe("Die");
    }
  }),
);

it.effect("sqlErrorToDefect passes successful values through", () =>
  Effect.gen(function* () {
    const result = yield* sqlErrorToDefect(
      Effect.succeed([1, 2, 3] as ReadonlyArray<number>),
    );
    expect(result).toEqual([1, 2, 3]);
  }),
);

// ── takeFirstOption ─────────────────────────────────────────────────────

it.effect("takeFirstOption returns None for empty input", () =>
  Effect.gen(function* () {
    const result = yield* takeFirstOption(
      Effect.succeed([] as ReadonlyArray<{ id: string }>),
    );
    expect(Option.isNone(result)).toBe(true);
  }),
);

it.effect("takeFirstOption returns Some(row) for single-row input", () =>
  Effect.gen(function* () {
    const row = { id: "a" };
    const result = yield* takeFirstOption(
      Effect.succeed([row] as ReadonlyArray<{ id: string }>),
    );
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(row);
    }
  }),
);

// ── takeFirstOrElse ─────────────────────────────────────────────────────

it.effect("takeFirstOrElse fails with caller's orElse on empty input", () =>
  Effect.gen(function* () {
    const program = takeFirstOrElse(
      Effect.succeed([] as ReadonlyArray<number>),
      () => "missing",
    );
    const exit = yield* Effect.exit(program);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBe("missing");
    }
  }),
);

it.effect("takeFirstOrElse returns first row on non-empty input", () =>
  Effect.gen(function* () {
    const result = yield* takeFirstOrElse(
      Effect.succeed([7, 8, 9] as ReadonlyArray<number>),
      () => "missing",
    );
    expect(result).toBe(7);
  }),
);

// ── takeFirstOrFail ─────────────────────────────────────────────────────

it.effect(
  "takeFirstOrFail fails with NoSuchElementException on empty input",
  () =>
    Effect.gen(function* () {
      const program = takeFirstOrFail(
        Effect.succeed([] as ReadonlyArray<number>),
      );
      const exit = yield* Effect.exit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error).toBeInstanceOf(Cause.NoSuchElementException);
      } else {
        throw new Error("expected typed Fail with NoSuchElementException");
      }
    }),
);

it.effect("takeFirstOrFail returns first row on non-empty input", () =>
  Effect.gen(function* () {
    const result = yield* takeFirstOrFail(
      Effect.succeed([{ id: "first" }, { id: "second" }] as ReadonlyArray<{
        id: string;
      }>),
    );
    expect(result).toEqual({ id: "first" });
  }),
);
