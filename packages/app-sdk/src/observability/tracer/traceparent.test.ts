import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import {
  externalParentFromTraceparent,
  formatTraceparent,
  parseTraceparent,
  TraceparentInvalidError,
} from "./traceparent.js";

const VALID_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("traceparent", () => {
  it("parses and formats a valid W3C traceparent", () => {
    const parsed = Effect.runSync(parseTraceparent(VALID_TRACEPARENT));

    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(formatTraceparent(parsed)).toBe(VALID_TRACEPARENT);
  });

  it("rejects malformed traceparent strings with a typed error", () => {
    const exit = Effect.runSyncExit(parseTraceparent("not-a-traceparent"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(TraceparentInvalidError);
        expect(err.value.reason).toBe("MalformedString");
      }
    }
  });

  it("materializes an Effect external parent span from traceparent", () => {
    const parent = Effect.runSync(
      externalParentFromTraceparent(VALID_TRACEPARENT),
    );

    expect(parent?._tag).toBe("ExternalSpan");
    if (parent?._tag === "ExternalSpan") {
      expect(parent.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(parent.spanId).toBe("00f067aa0ba902b7");
      expect(parent.sampled).toBe(true);
    }
  });
});
