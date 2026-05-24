import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import * as fc from "fast-check";
import {
  InvalidCursorError,
  decodeListCursor,
  encodeListCursor,
  paginate,
  type ListCursorPosition,
} from "./list-cursor.js";

// Arbitrary valid `(sortKey, id)` positions: ISO-8601 timestamp + UUID.
const positionArb: fc.Arbitrary<ListCursorPosition> = fc.record({
  sortKey: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  id: fc.uuid(),
});

const identityPosition = (pos: ListCursorPosition): ListCursorPosition => pos;

// The typed error inside a failed decode Exit, or undefined for a defect /
// success. Asserting on this (rather than a `_tag` string literal) keeps
// the assertion structural.
function decodeFailure(token: string): InvalidCursorError | undefined {
  const exit = Effect.runSyncExit(decodeListCursor(token));
  if (!Exit.isFailure(exit)) return undefined;
  return Option.getOrUndefined(Cause.failureOption(exit.cause));
}

// Roundtrip property (residual per Principle 1): every valid position
// survives encode → decode unchanged.
function roundtripsPosition(pos: ListCursorPosition): void {
  const decoded = Effect.runSync(decodeListCursor(encodeListCursor(pos)));
  expect(decoded).toEqual(pos);
}

// A garbage token never yields a coerced half-parsed value: it either
// decodes to a well-formed `(sortKey, id)` pair (a coincidence the
// generator can hit) or fails with a typed `InvalidCursorError` — never
// a third outcome.
function garbageTokenIsTypedFailureOrValid(token: string): void {
  const exit = Effect.runSyncExit(decodeListCursor(token));
  if (Exit.isFailure(exit)) {
    expect(
      Option.getOrUndefined(Cause.failureOption(exit.cause)),
    ).toBeInstanceOf(InvalidCursorError);
    return;
  }
  // A successful decode is a real `(sortKey, id)` pair: re-encoding it
  // reproduces a token that decodes back to the same position (the
  // codec is a clean section through valid tokens).
  const pos = exit.value;
  const reDecoded = Effect.runSync(decodeListCursor(encodeListCursor(pos)));
  expect(reDecoded).toEqual(pos);
}

// `paginate` invariant: the emitted page is exactly `min(rows, limit)`
// rows, and `nextCursor` is present iff the batch overflowed.
function paginateSliceInvariant(
  rows: readonly ListCursorPosition[],
  limit: number,
): void {
  const { page, nextCursor } = paginate(rows, limit, identityPosition);
  expect(page.length).toBe(Math.min(rows.length, limit));
  expect(nextCursor !== undefined).toBe(rows.length > limit);
}

// On overflow, `nextCursor` decodes back to the limit-th row's position.
function paginateNextCursorPointsAtLimitRow(
  rows: readonly ListCursorPosition[],
  limit: number,
): void {
  fc.pre(rows.length > limit);
  const { nextCursor } = paginate(rows, limit, identityPosition);
  expect(nextCursor).toBeDefined();
  const decoded = Effect.runSync(decodeListCursor(nextCursor!));
  expect(decoded).toEqual(rows[limit - 1]);
}

describe("list-cursor codec", () => {
  it("roundtrips every valid (ISO-8601 sortKey, UUID id) position", () => {
    expect.hasAssertions();
    fc.assert(fc.property(positionArb, roundtripsPosition));
  });

  it("rejects a non-base64url / non-(sortKey,id) token typed", () => {
    expect.hasAssertions();
    fc.assert(fc.property(fc.string(), garbageTokenIsTypedFailureOrValid));
  });

  it("fails typed on a base64url payload that is not a (sortKey,id) pair", () => {
    const bad = Buffer.from("not-a-pair", "utf8").toString("base64url");
    expect(decodeFailure(bad)).toBeInstanceOf(InvalidCursorError);
  });

  it("fails typed when the sortKey is not ISO-8601", () => {
    const bad = Buffer.from(
      "2026-13-99 not-a-date 00000000-0000-4000-8000-000000000000",
      "utf8",
    ).toString("base64url");
    expect(decodeFailure(bad)).toBeInstanceOf(InvalidCursorError);
  });
});

describe("paginate", () => {
  it("page.length === min(rows.length, limit); nextCursor iff overflow", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.array(positionArb, { maxLength: 50 }),
        fc.integer({ min: 1, max: 60 }),
        paginateSliceInvariant,
      ),
    );
  });

  it("nextCursor encodes the limit-th row's position when overflowing", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.array(positionArb, { minLength: 1, maxLength: 50 }),
        fc.integer({ min: 1, max: 50 }),
        paginateNextCursorPointsAtLimitRow,
      ),
    );
  });
});
