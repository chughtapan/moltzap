/* eslint-disable agent-code-guard/async-keyword -- Temporal activity and client tests await the SDK's Promise-native boundary. */
/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only activity timelines pin one Temporal attempt and cleanup ordering. */

import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { CompletedLedgerReceipt } from "../run/execute.js";
import { LedgerCompletion, ledgerDigest, ledgerRef } from "../ledger/schema.js";
import {
  ledgerAllocationFailedSummary,
  programFinishedSummary,
} from "./controller/summary.js";
import { KubernetesCallFailed } from "./kubernetes/calls.js";
import type {
  RunControllerResult,
  RunLifecycleActivities,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import {
  executeRunSocietyWorkflow,
  LifecycleOperations,
  OPEN_RUN_STATUS,
  readOpenRuns,
  runLifecycleActivities,
  type ControllerObservation,
  type LifecycleOperationsService,
  type OpenRunLister,
  type RunSocietyWorkflowExecutionOptions,
} from "./temporal.js";

/** The exact client surface the module under test asks a caller to supply. */
type WorkflowExecutor = RunSocietyWorkflowExecutionOptions["client"];

const HEARTBEAT_EVENT = "heartbeat";

const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: "registry/controller@sha256:controller",
  supportImage: "registry/support@sha256:support",
  experimentModule: "export const runSpec = society;",
};
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
const PROGRAM_RESULT: RunControllerResult = {
  exitCode: 0,
  summary: programFinishedSummary(
    CompletedLedgerReceipt.make({
      ledger: Schema.decodeSync(ledgerRef)("temporal-activity-ledger"),
      completion: LedgerCompletion.make({
        ledgerFormatVersion: 1,
        runId: "temporal-activity-run",
        recordCount: 2,
        artifacts: { manifest: DIGEST, records: DIGEST },
      }),
    }),
  ),
};
const FAILED_RESULT: RunControllerResult = {
  exitCode: 1,
  summary: ledgerAllocationFailedSummary(),
};

interface FakeState {
  readonly events: string[];
  readonly observations: ControllerObservation[];
  readonly namespacePresence: boolean[];
}

function fakeOperations(state: FakeState): LifecycleOperationsService {
  return {
    bindHeartbeat: () => () => {
      state.events.push(HEARTBEAT_EVENT);
    },
    prepareRun: (input) =>
      Effect.sync(() => {
        state.events.push(`prepare:${input.namespace}`);
      }),
    observeController: () =>
      Effect.suspend(() => {
        state.events.push("observe-controller");
        const observation = state.observations.shift();
        return observation === undefined
          ? Effect.fail(
              new KubernetesCallFailed("supply a fake controller observation"),
            )
          : Effect.succeed(observation);
      }),
    deleteRunNamespace: (namespace) =>
      Effect.sync(() => {
        state.events.push(`delete:${namespace}`);
      }),
    runNamespaceExists: () =>
      Effect.sync(() => {
        state.events.push("observe-namespace");
        return state.namespacePresence.shift() ?? false;
      }),
    waitBeforeObservation: () =>
      Effect.sync(() => {
        state.events.push("wait");
      }),
  };
}

function fakeActivities(current: FakeState): RunLifecycleActivities {
  return Effect.runSync(
    runLifecycleActivities.pipe(
      Effect.provideService(LifecycleOperations, fakeOperations(current)),
    ),
  );
}

function state(
  observations: ControllerObservation[] = [],
  namespacePresence: boolean[] = [],
): FakeState {
  return { events: [], observations, namespacePresence };
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The regression-only group shares one fake Temporal state machine whose event order is the contract under test.
describe("run lifecycle activities", () => {
  const operationsOf = (recorded: { readonly events: readonly string[] }) =>
    recorded.events.filter((event) => event !== HEARTBEAT_EVENT);

  it("creates one controller attempt and waits for its successful Job", async () => {
    const current = state([
      { _tag: "running" },
      { _tag: "succeeded", result: PROGRAM_RESULT },
    ]);
    const activities = fakeActivities(current);

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      PROGRAM_RESULT,
    );
    // Proof of life runs on its own schedule, not between observations.
    expect(operationsOf(current)).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
      "wait",
      "observe-controller",
    ]);
    // The attempt proves itself alive before it starts admitting a cohort.
    // Preparing a large one outlasts the deadline, so a signal that waits for
    // the observation loop arrives too late.
    expect(current.events[0]).toBe(HEARTBEAT_EVENT);
    expect(current.events.indexOf(HEARTBEAT_EVENT)).toBeLessThan(
      current.events.indexOf(`prepare:${INPUT.namespace}`),
    );
  });

  it("returns a closed failed result from a nonzero controller Job", async () => {
    const current = state([
      {
        _tag: "failed",
        detail: "controller Job failed",
        result: FAILED_RESULT,
      },
    ]);
    const activities = fakeActivities(current);

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      FAILED_RESULT,
    );
    expect(operationsOf(current)).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
    ]);
    expect(current.events).toContain(HEARTBEAT_EVENT);
  });

  it("fails the workflow activity with the retained controller diagnostic", async () => {
    const current = state([
      { _tag: "failed", detail: "controller Job failed\napplication failed" },
    ]);
    const activities = fakeActivities(current);

    await expect(activities.runControllerOnce(INPUT)).rejects.toMatchObject({
      name: "ControllerAttemptFailed",
      message: "controller Job failed\napplication failed",
    });
    expect(operationsOf(current)).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
    ]);
    expect(current.events).toContain(HEARTBEAT_EVENT);
  });

  it("deletes the namespace idempotently and waits until it is absent", async () => {
    const current = state([], [true, true, false]);
    const activities = fakeActivities(current);

    await expect(
      activities.cleanupRun({
        runId: INPUT.runId,
        namespace: INPUT.namespace,
      }),
    ).resolves.toBeUndefined();
    expect(current.events).toEqual([
      `delete:${INPUT.namespace}`,
      "observe-namespace",
      "wait",
      "observe-namespace",
      "wait",
      "observe-namespace",
    ]);
  });
});

describe("readOpenRuns", () => {
  const taskQueue = "moltzap-simulator";
  const openRunIds = ["mz-open-1", "mz-open-2"];

  async function* listed(
    workflowIds: readonly string[],
  ): AsyncIterable<{ readonly workflowId: string }> {
    for (const workflowId of workflowIds) {
      yield await Promise.resolve({ workflowId });
    }
  }

  it("names the runs the queue has not finished, asking only about that queue", async () => {
    const queries: string[] = [];
    const client: OpenRunLister = {
      list: (options) => {
        queries.push(options.query);
        return listed(openRunIds);
      },
    };

    await expect(
      Effect.runPromise(readOpenRuns(client, taskQueue)),
    ).resolves.toEqual({ _tag: "open", workflowIds: openRunIds });
    expect(queries[0]).toContain(taskQueue);
    expect(queries[0]).toContain(OPEN_RUN_STATUS);
  });

  // The distinction the roll guard depends on: a queue that cannot be listed
  // must not read as a queue with nothing on it.
  it("reports a listing it could not make as unreadable rather than as empty", async () => {
    const client: OpenRunLister = {
      list: () => {
        throw new Error("visibility store unavailable");
      },
    };

    await expect(
      Effect.runPromise(readOpenRuns(client, taskQueue)),
    ).resolves.toEqual({ _tag: "unreadable" });
  });
});

describe("executeRunSocietyWorkflow", () => {
  it("starts one caller-identified workflow and waits for its result", async () => {
    const execute = vi
      .fn<WorkflowExecutor["execute"]>()
      .mockResolvedValue(PROGRAM_RESULT);
    const client: WorkflowExecutor = { execute };

    await expect(
      executeRunSocietyWorkflow(INPUT, {
        client,
        workflowId: "workflow-run-1",
        taskQueue: "moltzap-simulator",
      }),
    ).resolves.toEqual(PROGRAM_RESULT);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("runSocietyWorkflow", {
      workflowId: "workflow-run-1",
      taskQueue: "moltzap-simulator",
      args: [INPUT],
    });
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after Temporal activity and client assertions. */
/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test requirements after the Temporal lifecycle regressions. */
