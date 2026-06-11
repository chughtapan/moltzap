import * as Socket from "@effect/platform/Socket";
import { Exit } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_GRACEFUL_CLOSE, extractCloseInfo } from "./close-info.js";

describe("extractCloseInfo", () => {
  it("treats no-status close as graceful teardown", () => {
    const exit = Exit.fail(
      new Socket.SocketCloseError({
        reason: "Close",
        code: 1005,
      }),
    );
    expect(extractCloseInfo(exit)).toEqual(DEFAULT_GRACEFUL_CLOSE);
  });

  it("preserves explicit clean close code and reason", () => {
    const exit = Exit.fail(
      new Socket.SocketCloseError({
        reason: "Close",
        code: 1001,
        closeReason: "going away",
      }),
    );
    expect(extractCloseInfo(exit)).toEqual({
      code: 1001,
      reason: "going away",
    });
  });
});
