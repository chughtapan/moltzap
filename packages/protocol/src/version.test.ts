/* eslint-disable agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- regression-only suite per the v5+ plan §8: each case names a specific contract case (lex vs numeric ordering, year boundary, wire-error reason discriminants). CalVer string literals are contractual values pinned by the plan; making them imports would lose the regression intent. */

import { describe, expect, it } from "vitest";
import { Effect, Either, Exit } from "effect";
import fc from "fast-check";

import {
  compareProtocolVersion,
  checkProtocolRange,
  InvalidProtocolVersionError,
  PROTOCOL_VERSION,
} from "./version.js";
import {
  ProtocolMismatchError,
  type ProtocolMismatchReason,
} from "./network/methods.js";

// regression-only: each case names a specific failure mode the v5 plan
// enumerates (lex vs numeric ordering, year boundary, equality, etc.).
describe("compareProtocolVersion (architect plan #706 v5 — codex r4 P2 #1)", () => {
  it("returns 0 for equal versions", () => {
    expect(compareProtocolVersion("2026.527.0", "2026.527.0")).toBe(0);
  });

  it("returns -1 when the left version is older (middle segment bump)", () => {
    expect(compareProtocolVersion("2026.526.0", "2026.527.0")).toBe(-1);
  });

  it("uses numeric — NOT lexicographic — ordering on segments", () => {
    expect(compareProtocolVersion("2026.1001.0", "2026.527.0")).toBe(1);
  });

  it("crosses the year boundary correctly", () => {
    expect(compareProtocolVersion("2025.999.0", "2026.1.0")).toBe(-1);
  });

  it("compares the patch segment when major+minor match", () => {
    expect(compareProtocolVersion("2026.527.0", "2026.527.1")).toBe(-1);
    expect(compareProtocolVersion("2026.527.2", "2026.527.1")).toBe(1);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareProtocolVersion("2026.527", "2026.527.0")).toBe(0);
    expect(compareProtocolVersion("2026.527.0", "2026.527.1")).toBe(-1);
  });

  it("throws InvalidProtocolVersionError on a non-numeric segment", () => {
    expect(() =>
      compareProtocolVersion("2026.527.0-rc.1", "2026.527.0"),
    ).toThrow(InvalidProtocolVersionError);
    expect(() => compareProtocolVersion("2026.abc.0", "2026.527.0")).toThrow(
      InvalidProtocolVersionError,
    );
  });

  it("throws InvalidProtocolVersionError on an empty segment (fail-closed)", () => {
    // review-senior P3 #2: `Number("") === 0` silently coerced empty
    // segments. The strict `^[0-9]+$` parser catches this now.
    expect(() => compareProtocolVersion("2026..0", "2026.527.0")).toThrow(
      InvalidProtocolVersionError,
    );
    expect(() => compareProtocolVersion("2026.527.", "2026.527.0")).toThrow(
      InvalidProtocolVersionError,
    );
    expect(() => compareProtocolVersion(".527.0", "2026.527.0")).toThrow(
      InvalidProtocolVersionError,
    );
    expect(() => compareProtocolVersion("", "2026.527.0")).toThrow(
      InvalidProtocolVersionError,
    );
  });

  it("error data carries the offending version + segment", () => {
    try {
      compareProtocolVersion("2026.abc.0", "2026.527.0");
      throw new Error("expected compareProtocolVersion to throw");
    } catch (e) {
      if (!(e instanceof InvalidProtocolVersionError)) {
        throw new Error(
          `expected InvalidProtocolVersionError, got ${String(e)}`,
        );
      }
      expect(e.version).toBe("2026.abc.0");
      expect(e.segment).toBe("abc");
      // Data.TaggedError discriminant.
      expect(e._tag).toBe("InvalidProtocolVersionError");
    }
  });
});

type CheckProtocolRangeError =
  | ProtocolMismatchError
  | InvalidProtocolVersionError;

const errorOrThrow = (
  result: Either.Either<void, CheckProtocolRangeError>,
): CheckProtocolRangeError =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("expected checkProtocolRange to fail, but it succeeded");
    },
  });

const expectMismatch = (
  err: CheckProtocolRangeError,
): ProtocolMismatchError => {
  if (!(err instanceof ProtocolMismatchError)) {
    throw new Error(
      `expected ProtocolMismatchError, got ${err._tag} (${err.message})`,
    );
  }
  return err;
};

const expectInvalidVersion = (
  err: CheckProtocolRangeError,
): InvalidProtocolVersionError => {
  if (!(err instanceof InvalidProtocolVersionError)) {
    throw new Error(
      `expected InvalidProtocolVersionError, got ${err._tag} (${err.message})`,
    );
  }
  return err;
};

/**
 * Trust-boundary invariant per the codex PR review P2: for arbitrary
 * client-supplied strings, `checkProtocolRange` must NEVER surface a
 * defect (`Die` cause). The two acceptable outcomes are typed
 * `Right` (in-range) or typed `Left` (`ProtocolMismatchError` or
 * `InvalidProtocolVersionError`). Reused by the property test below.
 */
const checkInputIsNotDefect = (min: string, max: string): boolean => {
  const exit = Effect.runSyncExit(
    checkProtocolRange(
      { minProtocol: min, maxProtocol: max },
      PROTOCOL_VERSION,
    ),
  );
  if (Exit.isSuccess(exit)) return true;
  // A `Die` cause means a sync throw escaped past the Effect.try
  // wrapper — the invariant we want to falsify if violated. `Fail`
  // (a typed E-channel error) is the desired shape.
  return exit.cause._tag !== "Die";
};

// regression-only: each case covers a specific reason discriminant the
// v9 plan §8 enumerates (server-above-client-max, server-below-client-min,
// in-range).
describe("checkProtocolRange (architect plan #706 v9 — codex r8 P2 #1)", () => {
  it("succeeds when the server version is bracketed by [minProtocol, maxProtocol]", () => {
    const exit = Effect.runSyncExit(
      checkProtocolRange(
        { minProtocol: "2026.526.0", maxProtocol: "2026.527.0" },
        "2026.527.0",
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails with server-above-client-max when max < serverVersion", () => {
    const error = expectMismatch(
      errorOrThrow(
        Effect.runSync(
          Effect.either(
            checkProtocolRange(
              { minProtocol: "2026.526.0", maxProtocol: "2026.526.0" },
              "2026.527.0",
            ),
          ),
        ),
      ),
    );
    const expectedReason: ProtocolMismatchReason = "server-above-client-max";
    expect(error.data.reason).toBe(expectedReason);
    expect(error.data.serverVersion).toBe("2026.527.0");
    expect(error.data.clientMaxProtocol).toBe("2026.526.0");
  });

  it("fails with server-below-client-min when min > serverVersion", () => {
    const error = expectMismatch(
      errorOrThrow(
        Effect.runSync(
          Effect.either(
            checkProtocolRange(
              { minProtocol: "2026.528.0", maxProtocol: "2026.530.0" },
              "2026.527.0",
            ),
          ),
        ),
      ),
    );
    const expectedReason: ProtocolMismatchReason = "server-below-client-min";
    expect(error.data.reason).toBe(expectedReason);
    expect(error.data.serverVersion).toBe("2026.527.0");
    expect(error.data.clientMinProtocol).toBe("2026.528.0");
  });

  it("can be called against the live PROTOCOL_VERSION", () => {
    const exit = Effect.runSyncExit(
      checkProtocolRange(
        { minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION },
        PROTOCOL_VERSION,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // P2 fix-roll (codex PR review #1 P2). The sync throw in
  // `compareProtocolVersion` is now wrapped in `Effect.try` so the
  // parse error reaches `checkProtocolRange`'s typed E channel
  // instead of escaping into the JSON-RPC handler as a defect.
  describe("malformed client input lands on the Effect E channel (P2)", () => {
    it("maps to InvalidProtocolVersionError when maxProtocol is malformed", () => {
      const error = expectInvalidVersion(
        errorOrThrow(
          Effect.runSync(
            Effect.either(
              checkProtocolRange(
                { minProtocol: "2026.526.0", maxProtocol: "abc.def.ghi" },
                "2026.527.0",
              ),
            ),
          ),
        ),
      );
      expect(error._tag).toBe("InvalidProtocolVersionError");
      expect(error.version).toBe("abc.def.ghi");
    });

    it("maps to InvalidProtocolVersionError when minProtocol is malformed", () => {
      const error = expectInvalidVersion(
        errorOrThrow(
          Effect.runSync(
            Effect.either(
              checkProtocolRange(
                { minProtocol: "2026..0", maxProtocol: "2026.527.0" },
                "2026.527.0",
              ),
            ),
          ),
        ),
      );
      expect(error.version).toBe("2026..0");
    });

    // Property test: `checkProtocolRange` is a trust-boundary helper
    // (codex PR review #1 P2). For ARBITRARY client-supplied strings,
    // the returned Effect's outcome is always a typed `Left` (one of
    // ProtocolMismatchError, InvalidProtocolVersionError) or `Right`
    // — never a sync throw, never a defect. The invariant: untrusted
    // client input crossing the boundary cannot turn into an
    // internal defect.
    it("for any client-supplied min/max strings, checkProtocolRange never throws synchronously and never produces a defect", () => {
      const property = fc.property(
        fc.string(),
        fc.string(),
        checkInputIsNotDefect,
      );
      const result = fc.check(property, { numRuns: 200 });
      // Witness `expect` keeps sonarjs/assertions-in-tests happy.
      expect(result.failed).toBe(false);
    });
  });
});
