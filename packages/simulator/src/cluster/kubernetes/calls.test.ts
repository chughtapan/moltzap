/** @file Finite Kubernetes call deadlines and current-status recognition. */

import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import { describe } from "vitest";
import {
  currentConditionIsTrue,
  DEFAULT_KUBERNETES_CALL_TIMEOUT_MS,
  KUBERNETES_CALL_TIMEOUT_VARIABLE,
  kubernetesCall,
  KubernetesCallFailed,
  kubernetesCallTimeout,
} from "./calls.js";

describe("currentConditionIsTrue", () => {
  it("accepts only a positive condition for the current object generation", () => {
    expect(
      currentConditionIsTrue(
        {
          metadata: { generation: 4 },
          status: {
            conditions: [
              { type: "Ready", status: "True", observedGeneration: 3 },
              { type: "Admitted", status: "True", observedGeneration: 4 },
            ],
          },
        },
        "Admitted",
      ),
    ).toBe(true);
  });

  it("rejects stale, false, and absent conditions", () => {
    expect(
      currentConditionIsTrue(
        {
          metadata: { generation: 4 },
          status: {
            conditions: [
              { type: "Admitted", status: "True", observedGeneration: 3 },
              { type: "Ready", status: "False", observedGeneration: 4 },
            ],
          },
        },
        "Admitted",
      ),
    ).toBe(false);
    expect(
      currentConditionIsTrue({ metadata: { generation: 1 } }, "Ready"),
    ).toBe(false);
  });
});

describe("kubernetesCall", () => {
  const operation = "observe run worker";
  const answer = "the cluster's answer";

  it.effect("fails an unanswered call with a typed diagnostic", () =>
    Effect.gen(function* () {
      const bound = Duration.seconds(1);
      const unanswered = new Promise<never>(() => {
        // The accepted request deliberately remains unanswered.
      });
      const failureFiber = yield* kubernetesCall(
        operation,
        () => unanswered,
        bound,
      ).pipe(Effect.flip, Effect.fork);

      yield* Effect.yieldNow();
      yield* TestClock.adjust(bound);
      const failure = yield* Fiber.join(failureFiber);

      expect(failure).toBeInstanceOf(KubernetesCallFailed);
      expect(failure.message).toBe(`${operation} did not answer in time`);
      expect(failure.absent).toBe(false);
    }),
  );

  it.effect("returns a call that answers inside the bound", () =>
    Effect.gen(function* () {
      const result = yield* kubernetesCall(
        operation,
        () => Promise.resolve(answer),
        Duration.seconds(1),
      );

      expect(result).toBe(answer);
    }),
  );
});

describe("kubernetesCallTimeout", () => {
  it("defaults to thirty seconds", () => {
    expect(Duration.toMillis(kubernetesCallTimeout({}))).toBe(
      DEFAULT_KUBERNETES_CALL_TIMEOUT_MS,
    );
  });

  it("accepts a positive millisecond environment override", () => {
    const configured = 5_000;

    expect(
      Duration.toMillis(
        kubernetesCallTimeout({
          [KUBERNETES_CALL_TIMEOUT_VARIABLE]: String(configured),
        }),
      ),
    ).toBe(configured);
  });

  it("uses the default for unusable overrides", () => {
    for (const encoded of ["", "0", "-1", "1.5", "forever"]) {
      expect(
        Duration.toMillis(
          kubernetesCallTimeout({
            [KUBERNETES_CALL_TIMEOUT_VARIABLE]: encoded,
          }),
        ),
      ).toBe(DEFAULT_KUBERNETES_CALL_TIMEOUT_MS);
    }
  });
});
