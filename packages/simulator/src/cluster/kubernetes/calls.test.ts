/* eslint-disable agent-code-guard/async-keyword -- Vitest awaits the Effect this Promise-native Kubernetes boundary returns. */

import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  currentConditionIsTrue,
  kubernetesCall,
  kubernetesCallTimeout,
  KubernetesCallFailed,
  KUBERNETES_CALL_TIMEOUT_VARIABLE,
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
  const bound = Duration.millis(10);
  const answer = "the cluster's answer";

  // The failure mode this bound exists for: an API server that accepts the
  // connection and then answers nothing leaves a submission waiting with no
  // output naming what it waits for.
  it("abandons a call the cluster never answers, naming the operation", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        kubernetesCall(
          operation,
          () =>
            new Promise<never>(() => {
              // Accepted and never answered, which is the case under test.
            }),
          bound,
        ),
      ),
    );

    expect(failure).toBeInstanceOf(KubernetesCallFailed);
    expect(failure.message).toContain(operation);
    // Never answering is not the cluster answering that the object is gone,
    // which the callers that tolerate absence would swallow.
    expect(failure.absent).toBe(false);
  });

  it("returns a call the cluster answers inside its bound", async () => {
    await expect(
      Effect.runPromise(
        kubernetesCall(operation, () => Promise.resolve(answer), bound),
      ),
    ).resolves.toBe(answer);
  });
});

describe("kubernetesCallTimeout", () => {
  it("takes a positive millisecond override from the environment", () => {
    const configured = 5_000;

    expect(
      kubernetesCallTimeout({
        [KUBERNETES_CALL_TIMEOUT_VARIABLE]: String(configured),
      }),
    ).toEqual(Duration.millis(configured));
  });

  it("keeps its default when no usable override is set", () => {
    const fallback = kubernetesCallTimeout({});

    for (const encoded of ["", "0", "-1", "1.5", "forever"]) {
      expect(
        kubernetesCallTimeout({
          [KUBERNETES_CALL_TIMEOUT_VARIABLE]: encoded,
        }),
      ).toEqual(fallback);
    }
    expect(Duration.toMillis(fallback)).toBeGreaterThan(0);
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after the Promise-native Kubernetes boundary. */
