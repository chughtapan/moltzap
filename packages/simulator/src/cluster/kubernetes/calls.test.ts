/** @file Kubernetes condition freshness, call deadlines, and context-selection regressions. */

import { ApiException } from "@kubernetes/client-node";
import { Cause, Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  currentConditionIsTrue,
  KUBERNETES_CALL_TIMEOUT_VARIABLE,
  kubernetesCall,
  KubernetesCallFailed,
  kubernetesCallTimeout,
  readFailureDetail,
  selectConfiguredKubeContext,
} from "./calls.js";

const LOCAL_KUBE_CONTEXT = "kind-moltzap-isolated";

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

describe("selectConfiguredKubeContext", () => {
  it("selects the exact context carried by a local profile", () => {
    let selected: string | undefined;
    selectConfiguredKubeContext(
      {
        getContextObject: (name) =>
          name === LOCAL_KUBE_CONTEXT ? { name } : null,
        setCurrentContext: (name) => {
          selected = name;
        },
      },
      { kind: "local", kubeContext: LOCAL_KUBE_CONTEXT },
    );

    expect(selected).toBe(LOCAL_KUBE_CONTEXT);
  });

  it("rejects a context absent from the loaded kubeconfig", () => {
    expect(() => {
      selectConfiguredKubeContext(
        {
          getContextObject: () => null,
          setCurrentContext: () => {
            throw new Error("an absent context must not be selected");
          },
        },
        { kind: "local", kubeContext: LOCAL_KUBE_CONTEXT },
      );
    }).toThrow(KubernetesCallFailed);
  });

  it("retains ambient kubeconfig selection for the compatible local default", () => {
    let consulted = false;
    selectConfiguredKubeContext(
      {
        getContextObject: () => {
          consulted = true;
          return null;
        },
        setCurrentContext: () => {
          consulted = true;
        },
      },
      { kind: "local" },
    );

    expect(consulted).toBe(false);
  });
});

describe("readFailureDetail", () => {
  const operation = "read application file";

  it("names an API status and says nothing else the server sent", () => {
    const failure = new KubernetesCallFailed(
      operation,
      new ApiException(403, "Forbidden", { secret: "body" }, {}),
    );

    expect(readFailureDetail(failure)).toBe(
      "read application file failed (Kubernetes 403)",
    );
  });

  it("appends what the transport said when the session was refused", () => {
    const failure = new KubernetesCallFailed(
      operation,
      new Error("Unexpected server response: 403"),
    );

    expect(readFailureDetail(failure)).toBe(
      "read application file failed: Unexpected server response: 403",
    );
  });

  it("reports an unanswered call once, without the timeout's own text", () => {
    const failure = new KubernetesCallFailed(
      operation,
      new Cause.TimeoutException(),
    );

    expect(readFailureDetail(failure)).toBe(
      "read application file did not answer in time",
    );
  });

  it("keeps the operator message when the cause is not an error", () => {
    expect(readFailureDetail(new KubernetesCallFailed(operation))).toBe(
      "read application file failed",
    );
  });
});
