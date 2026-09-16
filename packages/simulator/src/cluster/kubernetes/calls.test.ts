/** @file Kubernetes condition freshness, call deadlines, and context-selection regressions. */

import { effect as effectTest } from "@effect/vitest";
import {
  ApiException,
  AppsV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
} from "@kubernetes/client-node";
import {
  Cause,
  Duration,
  Effect,
  Fiber,
  Option,
  Schema,
  TestClock,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentConditionIsTrue,
  KUBERNETES_CALL_TIMEOUT_VARIABLE,
  kubernetesCall,
  KubernetesCallFailed,
  kubernetesCallTimeout,
  makeInClusterKubernetesSocietyApi,
  makeKubernetesRunControlApi,
  makeKubernetesRunWorkerInstallApi,
  readFailureDetail,
  selectConfiguredKubeContext,
} from "./calls.js";

const LOCAL_KUBE_CONTEXT = "kind-moltzap-isolated";

function controllerLogFixture(lines: readonly string[]) {
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockReturnValue(undefined);
  vi.spyOn(KubeConfig.prototype, "getCurrentCluster").mockReturnValue({
    name: "test",
    server: "https://kubernetes.invalid",
    skipTLSVerify: false,
  });
  vi.spyOn(CoreV1Api.prototype, "listNamespacedPod").mockResolvedValue({
    items: [{ metadata: { name: "controller-pod" } }],
  });
  const read = vi
    .spyOn(CoreV1Api.prototype, "readNamespacedPodLog")
    .mockImplementation((request) =>
      Promise.resolve(
        Buffer.from(
          `${lines.slice(-(request.tailLines ?? lines.length)).join("\n")}\n`,
        )
          .subarray(0, request.limitBytes)
          .toString("utf8"),
      ),
    );
  return { api: makeKubernetesRunControlApi(), read };
}

describe("bounded controller log tails", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      name: "many warning lines",
      warnings: Array.from({ length: 199 }, () => "w".repeat(1024)),
    },
    { name: "one oversized warning line", warnings: ["w".repeat(16_384)] },
  ])("recovers the final receipt after $name", async ({ warnings }) => {
    const receipt =
      'moltzap.controller-result/v1 {"_tag":"LedgerAllocationFailed"}';
    const { api, read } = controllerLogFixture([...warnings, receipt]);

    const output = await Effect.runPromise(
      api.readControllerLogs("run", 200, 8192),
    );

    expect(output?.endsWith(`${receipt}\n`)).toBe(true);
    expect(read.mock.calls.length).toBeGreaterThan(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(9);
    expect(
      read.mock.calls.every(([request]) => request.limitBytes === 8192),
    ).toBe(true);
  });

  it("keeps trailing failure diagnostics beside the receipt without another read", async () => {
    const lines = [
      'moltzap.controller-result/v1 {"_tag":"LedgerAllocationFailed"}',
      "Simulator controller execution failed",
    ];
    const { api, read } = controllerLogFixture(lines);

    const output = await Effect.runPromise(
      api.readControllerLogs("run", 200, 8192),
    );

    expect(output).toBe(`${lines.join("\n")}\n`);
    expect(read).toHaveBeenCalledOnce();
  });
});

function harvestProbe() {
  vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockReturnValue(undefined);
  vi.spyOn(KubeConfig.prototype, "getCurrentCluster").mockReturnValue({
    name: "test",
    server: "https://kubernetes.invalid",
    skipTLSVerify: false,
  });
  vi.spyOn(Exec.prototype, "exec").mockImplementation(
    () => new Promise<never>(vi.fn()),
  );
  return makeInClusterKubernetesSocietyApi("test-run");
}

describe("application harvest deadlines", () => {
  afterEach(() => vi.restoreAllMocks());

  effectTest(
    "allows the full finalization probe budget before timing out at seventy seconds",
    () =>
      Effect.gen(function* () {
        const api = harvestProbe();
        const pending = yield* api
          .readApplicationFile(
            "agent-pod",
            "/var/run/moltzap/finalized.json",
            65536,
            "finalize",
          )
          .pipe(Effect.flip, Effect.fork);
        yield* TestClock.adjust("30 seconds");
        expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
        yield* TestClock.adjust("30 seconds");
        expect(Option.isNone(yield* Fiber.poll(pending))).toBe(true);
        yield* TestClock.adjust("10 seconds");
        const failure = yield* Fiber.join(pending);
        expect(failure.detail).toContain("read application file");
      }),
  );

  effectTest("still abandons an ordinary file read after thirty seconds", () =>
    Effect.gen(function* () {
      const api = harvestProbe();
      const pending = yield* api
        .readApplicationFile("agent-pod", "/workspace/output.txt", 65536)
        .pipe(Effect.flip, Effect.fork);
      yield* TestClock.adjust("30 seconds");
      const failure = yield* Fiber.join(pending);
      expect(failure.detail).toContain("read application file");
    }),
  );
});

describe("isolated worker installation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prepares, applies, and observes only the selected worker deployment", async () => {
    vi.spyOn(KubeConfig.prototype, "loadFromDefault").mockReturnValue(
      undefined,
    );
    vi.spyOn(KubeConfig.prototype, "getCurrentCluster").mockReturnValue({
      name: "test",
      server: "https://kubernetes.invalid",
      skipTLSVerify: false,
    });
    const patch = vi
      .spyOn(AppsV1Api.prototype, "patchNamespacedDeployment")
      .mockResolvedValue({});
    const read = vi
      .spyOn(AppsV1Api.prototype, "readNamespacedDeployment")
      .mockResolvedValue({});
    const api = makeKubernetesRunWorkerInstallApi({
      workerName: "isolated-worker",
      controllerImage: "controller:test",
      taskQueue: "isolated-queue",
      temporalAddress: "temporal:7233",
      temporalNamespace: "default",
      profile: { kind: "local" },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* api.install("deployment");
        yield* api.readInstalledWorkerImage();
        yield* api.readWorkerAvailability();
      }),
    );

    expect(patch.mock.calls.map(([request]) => request.name)).toEqual([
      "isolated-worker",
      "isolated-worker",
    ]);
    expect(read.mock.calls.map(([request]) => request.name)).toEqual([
      "isolated-worker",
      "isolated-worker",
    ]);
    const applied = Schema.decodeUnknownSync(
      Schema.Struct({ metadata: Schema.Struct({ name: Schema.String }) }),
    )(patch.mock.lastCall?.[0].body);
    expect(applied).toEqual({ metadata: { name: "isolated-worker" } });
  });
});

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
