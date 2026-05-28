/* eslint-disable agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals, max-lines-per-function, sonarjs/max-lines-per-function -- regression-only suite per the v5+ plan §8: each case names a specific contract case (lex vs numeric ordering, year boundary, wire-error reason discriminants). CalVer string literals are contractual values pinned by the plan; making them imports would lose the regression intent. */

import { describe, expect, it } from "vitest";
import { Effect, Either, Exit } from "effect";

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
});

const errorOrThrow = (
  result: Either.Either<void, ProtocolMismatchError>,
): ProtocolMismatchError =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("expected checkProtocolRange to fail, but it succeeded");
    },
  });

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
    const error = errorOrThrow(
      Effect.runSync(
        Effect.either(
          checkProtocolRange(
            { minProtocol: "2026.526.0", maxProtocol: "2026.526.0" },
            "2026.527.0",
          ),
        ),
      ),
    );
    const expectedReason: ProtocolMismatchReason = "server-above-client-max";
    expect(error).toBeInstanceOf(ProtocolMismatchError);
    expect(error.data.reason).toBe(expectedReason);
    expect(error.data.serverVersion).toBe("2026.527.0");
    expect(error.data.clientMaxProtocol).toBe("2026.526.0");
  });

  it("fails with server-below-client-min when min > serverVersion", () => {
    const error = errorOrThrow(
      Effect.runSync(
        Effect.either(
          checkProtocolRange(
            { minProtocol: "2026.528.0", maxProtocol: "2026.530.0" },
            "2026.527.0",
          ),
        ),
      ),
    );
    const expectedReason: ProtocolMismatchReason = "server-below-client-min";
    expect(error).toBeInstanceOf(ProtocolMismatchError);
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
});
