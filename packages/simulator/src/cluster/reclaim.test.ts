/** @file Temporal workflow attempt bounds and unconditional namespace cleanup regressions. */

import type * as Workflow from "@temporalio/workflow"; // eslint-disable-line no-restricted-imports -- Type the mocked workflow SDK boundary.
import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow"; // eslint-disable-line no-restricted-imports -- Assert native workflow failure types at the mocked SDK boundary.
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CleanupRunInput,
  ControllerRunResult,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import { LedgerCompletion, ledgerDigest, ledgerRef } from "../ledger/schema.js";
import { CompletedLedgerReceipt } from "../run/execute.js";
import { programFinishedSummary } from "./controller/summary.js";
import { KubernetesCallFailed } from "./kubernetes/calls.js";
import {
  LifecycleOperations,
  type LifecycleOperationsService,
  runLifecycleActivities,
} from "./temporal.js";

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-invalid-void-type, agent-code-guard/promise-type -- Temporal workflow tests exercise Promise-native SDK contracts; activity doubles resolve synchronously while retaining those signatures. */

interface MockActivityOptions {
  readonly startToCloseTimeout: string;
  readonly heartbeatTimeout?: string;
  readonly retry?: {
    readonly maximumAttempts?: number;
    readonly initialInterval?: string;
    readonly maximumInterval?: string;
  };
}

const DIGEST = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const CONTROLLER_RESULT: ControllerRunResult = {
  exitCode: 0,
  summary: programFinishedSummary(
    CompletedLedgerReceipt.make({
      ledger: Schema.decodeSync(ledgerRef)("temporal-workflow-ledger"),
      completion: LedgerCompletion.make({
        ledgerFormatVersion: 1,
        runId: "temporal-workflow-run",
        recordCount: 3,
        artifacts: { manifest: DIGEST, records: DIGEST },
      }),
    }),
  ),
};

interface WorkflowTestState {
  readonly activityOptions: MockActivityOptions[];
  readonly controllerInputs: RunSocietyWorkflowInput[];
  readonly cleanupInputs: CleanupRunInput[];
  readonly events: string[];
  signalHandler?: () => Promise<void>;
  controllerActivity?: () => Promise<ControllerRunResult>;
  stopActivity?: () => Promise<void>;
  controllerFailure?: Error;
  cleanupFailure?: Error;
  /** Real cleanup activity substituted for the double when a test supplies one. */
  cleanupActivity?: (input: CleanupRunInput) => Promise<void>;
}

const workflowState = vi.hoisted(
  (): WorkflowTestState => ({
    activityOptions: [],
    controllerInputs: [],
    cleanupInputs: [],
    events: [],
  }),
);

const mockCancellationScope = vi.hoisted(
  () =>
    class {
      private rejectCancellation!: (cause: Error) => void;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- A cancellation-only promise never resolves successfully.
      private readonly cancelled = new Promise<never>((resolve, reject) => {
        this.rejectCancellation = reject;
      });

      async run<Result>(evaluate: () => Promise<Result>): Promise<Result> {
        // eslint-disable-next-line agent-code-guard/no-promise-all-in-effect -- This mock implements Temporal's Promise-native scope cancellation boundary.
        return await Promise.race([evaluate(), this.cancelled]);
      }

      cancel(): void {
        workflowState.events.push("stop-cancelled");
        this.rejectCancellation(new Error("stop scope cancelled"));
      }

      static async nonCancellable<Result>(
        evaluate: () => Promise<Result>,
      ): Promise<Result> {
        workflowState.events.push("non-cancellable");
        return await evaluate();
      }
    },
);

vi.mock("@temporalio/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof Workflow>()),
  defineSignal: (name: string) => name,
  setHandler: (signal: string, handler: () => Promise<void>) => {
    expect(signal).toBe("cancelEvaluation");
    workflowState.signalHandler = handler;
  },
  proxyActivities: (options: MockActivityOptions) => {
    workflowState.activityOptions.push(options);
    return {
      runControllerOnce: async (
        input: RunSocietyWorkflowInput,
      ): Promise<ControllerRunResult> => {
        workflowState.events.push("controller");
        workflowState.controllerInputs.push(input);
        if (workflowState.controllerFailure !== undefined) {
          throw workflowState.controllerFailure;
        }
        return workflowState.controllerActivity === undefined
          ? CONTROLLER_RESULT
          : await workflowState.controllerActivity();
      },
      stopController: async (): Promise<void> => {
        workflowState.events.push("stop");
        await workflowState.stopActivity?.();
      },
      cleanupRun: async (input: CleanupRunInput): Promise<void> => {
        workflowState.events.push("cleanup");
        workflowState.cleanupInputs.push(input);
        if (workflowState.cleanupFailure !== undefined) {
          throw workflowState.cleanupFailure;
        }
        await workflowState.cleanupActivity?.(input);
      },
    };
  },
  log: { warn: () => undefined },
  CancellationScope: mockCancellationScope,
}));

const { runSocietyWorkflow } = await import("./reclaim.js");

const input: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: "registry/controller@sha256:controller",
  supportImage: "registry/support@sha256:support",
  experimentModule: "export const runSpec = society;",
};

beforeEach(() => {
  workflowState.controllerInputs.length = 0;
  workflowState.cleanupInputs.length = 0;
  workflowState.events.length = 0;
  delete workflowState.controllerFailure;
  delete workflowState.cleanupFailure;
  delete workflowState.cleanupActivity;
  delete workflowState.controllerActivity;
  delete workflowState.stopActivity;
  delete workflowState.signalHandler;
});

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The group shares one fake Temporal activity environment whose event order is the contract under test.
describe("runSocietyWorkflow", () => {
  it("bounds the controller attempt by a heartbeat and keeps cleanup retryable", () => {
    expect(workflowState.activityOptions).toEqual([
      {
        startToCloseTimeout: "24 hours",
        heartbeatTimeout: "60 seconds",
        retry: { maximumAttempts: 1 },
      },
      { startToCloseTimeout: "10 minutes" },
      {
        startToCloseTimeout: "30 seconds",
        retry: { initialInterval: "1 second", maximumInterval: "5 seconds" },
      },
    ]);
  });

  it("runs the controller once and cleans the run after success", async () => {
    await expect(runSocietyWorkflow(input)).resolves.toEqual({
      ...CONTROLLER_RESULT,
      cleanup: "complete",
    });

    expect(workflowState.controllerInputs).toEqual([input]);
    expect(workflowState.cleanupInputs).toEqual([
      { runId: input.runId, namespace: input.namespace },
    ]);
    expect(workflowState.events).toEqual([
      "controller",
      "non-cancellable",
      "cleanup",
    ]);
  });

  it("waits for retained controller evidence after a stop request before cleanup", async () => {
    let finish!: (result: ControllerRunResult) => void;
    workflowState.controllerActivity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = runSocietyWorkflow(input);
    await workflowState.signalHandler?.();
    expect(workflowState.events).toEqual(["controller", "stop"]);
    finish({
      exitCode: 1,
      summary: {
        _tag: "ClusterLost",
        receipt: CONTROLLER_RESULT.summary.receipt,
      },
    });
    const result = await pending;
    expect(result).toMatchObject({
      exitCode: 1,
      cancelled: true,
      cleanup: "complete",
    });
    expect(result.summary).toEqual({
      _tag: "ClusterLost",
      receipt: CONTROLLER_RESULT.summary.receipt,
    });
    expect(workflowState.events.at(-1)).toBe("cleanup");
  });

  it("shares one retrying stop request across repeated cancellation signals", async () => {
    let finish!: (result: ControllerRunResult) => void;
    let acceptStop!: () => void;
    workflowState.controllerActivity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    workflowState.stopActivity = () =>
      new Promise((resolve) => {
        acceptStop = resolve;
      });
    const pending = runSocietyWorkflow(input);
    const first = workflowState.signalHandler?.();
    const repeated = workflowState.signalHandler?.();
    expect(workflowState.events).toEqual(["controller", "stop"]);
    expect(repeated).toBe(first);
    acceptStop();
    await first;
    finish({
      exitCode: 1,
      summary: {
        _tag: "ClusterLost",
        receipt: CONTROLLER_RESULT.summary.receipt,
      },
    });
    await expect(pending).resolves.toMatchObject({
      cancelled: true,
      cleanup: "complete",
    });
  });

  it("cancels pending stop retries before cleanup when the controller finishes", async () => {
    let finish!: (result: ControllerRunResult) => void;
    workflowState.controllerActivity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    workflowState.stopActivity = () => new Promise(vi.fn());
    const pending = runSocietyWorkflow(input);
    const stop = workflowState.signalHandler?.();
    finish(CONTROLLER_RESULT);
    await expect(pending).resolves.toEqual({
      ...CONTROLLER_RESULT,
      cleanup: "complete",
    });
    await stop;
    expect(workflowState.events).toEqual([
      "controller",
      "stop",
      "stop-cancelled",
      "non-cancellable",
      "non-cancellable",
      "cleanup",
    ]);
    await workflowState.signalHandler?.();
    expect(
      workflowState.events.filter((event) => event === "stop"),
    ).toHaveLength(1);
  });

  it("does not claim cancellation after an unretryable stop failure", async () => {
    let finish!: (result: ControllerRunResult) => void;
    workflowState.controllerActivity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    workflowState.stopActivity = async () => {
      throw new Error("unretryable activity failure");
    };
    const pending = runSocietyWorkflow(input);
    await workflowState.signalHandler?.();
    finish({
      exitCode: 1,
      summary: {
        _tag: "ClusterLost",
        receipt: CONTROLLER_RESULT.summary.receipt,
      },
    });
    await expect(pending).resolves.toEqual({
      exitCode: 1,
      summary: {
        _tag: "ClusterLost",
        receipt: CONTROLLER_RESULT.summary.receipt,
      },
      cleanup: "complete",
    });
  });

  it("preserves the completed controller result when cleanup fails", async () => {
    workflowState.cleanupFailure = new Error("namespace deletion unavailable");
    await expect(runSocietyWorkflow(input)).resolves.toEqual({
      ...CONTROLLER_RESULT,
      cleanup: "failed",
    });
    expect(workflowState.controllerInputs).toHaveLength(1);
  });

  it("preserves the controller failure if cleanup also fails", async () => {
    const failure = new ActivityFailure(
      "controller failed first",
      "runControllerOnce",
      "controller-activity",
      "NON_RETRYABLE_FAILURE",
      "run-worker",
      ApplicationFailure.nonRetryable("controller lost"),
    );
    workflowState.controllerFailure = failure;
    workflowState.cleanupFailure = new Error("cleanup failed later");
    await expect(runSocietyWorkflow(input)).rejects.toBe(failure);
  });

  it("terminates after an unknown activity rejection instead of retrying workflow tasks", async () => {
    workflowState.controllerActivity = vi
      .fn<NonNullable<WorkflowTestState["controllerActivity"]>>()
      .mockRejectedValue("invalid activity failure");

    const result = runSocietyWorkflow(input);

    await expect(result).rejects.toBeInstanceOf(ApplicationFailure);
    await expect(result).rejects.toMatchObject({
      message: "invalid activity failure",
      type: "ControllerWorkflowFailure",
      nonRetryable: true,
    });
    expect(workflowState.controllerInputs).toHaveLength(1);
    expect(workflowState.cleanupInputs).toEqual([
      { runId: input.runId, namespace: input.namespace },
    ]);
  });

  it("cleans the run after the controller fails without retrying it", async () => {
    const failure = new Error("controller stopped");
    workflowState.controllerFailure = failure;

    await expect(runSocietyWorkflow(input)).rejects.toBe(failure);

    expect(workflowState.controllerInputs).toHaveLength(1);
    expect(workflowState.cleanupInputs).toEqual([
      { runId: input.runId, namespace: input.namespace },
    ]);
    expect(workflowState.events).toEqual([
      "controller",
      "non-cancellable",
      "cleanup",
    ]);
  });

  it("deletes the run namespace when the controller attempt is lost", async () => {
    const deleted: string[] = [];
    const operations: LifecycleOperationsService = {
      bindHeartbeat: () => () => undefined,
      prepareRun: () => Effect.void,
      requestControllerStop: () => Effect.void,
      observeController: () =>
        Effect.fail(new KubernetesCallFailed("observe a fake controller")),
      deleteRunNamespace: (namespace) =>
        Effect.sync(() => {
          deleted.push(namespace);
        }),
      runNamespaceExists: () => Effect.succeed(false),
      waitBeforeObservation: () => Effect.void,
    };
    workflowState.cleanupActivity = Effect.runSync(
      runLifecycleActivities.pipe(
        Effect.provideService(LifecycleOperations, operations),
      ),
    ).cleanupRun;
    workflowState.controllerFailure = new Error(
      "activity heartbeat deadline expired",
    );

    await expect(runSocietyWorkflow(input)).rejects.toBe(
      workflowState.controllerFailure,
    );

    expect(deleted).toEqual([input.namespace]);
  });
});

/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-invalid-void-type, agent-code-guard/promise-type -- Restore Effect-first test rules after the Temporal workflow contract suite. */
