import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { makeTracerLayer, TracerInitError } from "./runtime.js";

const BASE_OPTIONS = {
  appId: "test-app",
  serviceName: "test-app-service",
  shutdownTimeoutMs: 100,
};

describe("makeTracerLayer", () => {
  it("builds as a no-op layer when the endpoint is empty", () => {
    const exit = Effect.runSyncExit(
      Effect.scoped(
        Layer.build(
          makeTracerLayer({
            ...BASE_OPTIONS,
            otlpEndpoint: "",
          }),
        ),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("fails with TracerInitError for an invalid endpoint", () => {
    const exit = Effect.runSyncExit(
      Effect.scoped(
        Layer.build(
          makeTracerLayer({
            ...BASE_OPTIONS,
            otlpEndpoint: "not a url",
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(TracerInitError);
        expect(err.value.reason).toBe("InvalidEndpoint");
      }
    }
  });
});
