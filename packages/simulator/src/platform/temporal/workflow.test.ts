/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-invalid-void-type, agent-code-guard/async-keyword, agent-code-guard/promise-type -- Temporal workflow tests exercise Promise-native SDK contracts; activity doubles resolve synchronously while retaining those signatures. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { CompletedLedgerReceipt } from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import { programFinishedSummary } from "../controller/summary.js";
import type {
  CleanupRunInput,
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";

interface MockActivityOptions {
  readonly startToCloseTimeout: string;
  readonly retry?: { readonly maximumAttempts: number };
}

const DIGEST = Schema.decodeSync(ledgerDigest)("b".repeat(64));
const CONTROLLER_RESULT: RunControllerResult = {
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
  controllerFailure?: Error;
  cleanupFailure?: Error;
}

const workflowState = vi.hoisted(
  (): WorkflowTestState => ({
    activityOptions: [],
    controllerInputs: [],
    cleanupInputs: [],
    events: [],
  }),
);

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: (options: MockActivityOptions) => {
    workflowState.activityOptions.push(options);
    return {
      runControllerOnce: async (
        input: RunSocietyWorkflowInput,
      ): Promise<RunControllerResult> => {
        workflowState.events.push("controller");
        workflowState.controllerInputs.push(input);
        if (workflowState.controllerFailure !== undefined) {
          throw workflowState.controllerFailure;
        }
        return CONTROLLER_RESULT;
      },
      cleanupRun: async (input: CleanupRunInput): Promise<void> => {
        workflowState.events.push("cleanup");
        workflowState.cleanupInputs.push(input);
        if (workflowState.cleanupFailure !== undefined) {
          throw workflowState.cleanupFailure;
        }
      },
    };
  },
  CancellationScope: {
    nonCancellable: async <Result>(
      evaluate: () => Promise<Result>,
    ): Promise<Result> => {
      workflowState.events.push("non-cancellable");
      return await evaluate();
    },
  },
}));

const { runSocietyWorkflow } = await import("./workflow.js");

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
});

describe("runSocietyWorkflow", () => {
  it("schedules one controller attempt and keeps cleanup retryable", () => {
    expect(workflowState.activityOptions).toEqual([
      {
        startToCloseTimeout: "24 hours",
        retry: { maximumAttempts: 1 },
      },
      { startToCloseTimeout: "10 minutes" },
    ]);
  });

  it("runs the controller once and cleans the run after success", async () => {
    await expect(runSocietyWorkflow(input)).resolves.toEqual(CONTROLLER_RESULT);

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
});

/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-invalid-void-type, agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-first test rules after the Temporal workflow contract suite. */
