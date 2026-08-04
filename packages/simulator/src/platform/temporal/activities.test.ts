/* eslint-disable agent-code-guard/async-keyword -- Temporal activity tests await Promise-native activity results. */
/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only activity timelines pin one Temporal attempt and cleanup ordering. */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CompletedLedgerReceipt } from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import {
  ledgerAllocationFailedSummary,
  programFinishedSummary,
} from "../controller/summary.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";
import {
  makeRunLifecycleActivitiesWith,
  type ControllerObservation,
  type RunLifecycleOperations,
} from "./activities.js";

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

function fakeOperations(state: FakeState): RunLifecycleOperations {
  return {
    prepareRun: (input) => {
      state.events.push(`prepare:${input.namespace}`);
      return Promise.resolve();
    },
    observeController: () => {
      state.events.push("observe-controller");
      const observation = state.observations.shift();
      if (observation === undefined) {
        return Promise.reject(new Error("missing fake controller observation"));
      }
      return Promise.resolve(observation);
    },
    deleteRunNamespace: (namespace) => {
      state.events.push(`delete:${namespace}`);
      return Promise.resolve();
    },
    runNamespaceExists: () => {
      state.events.push("observe-namespace");
      return Promise.resolve(state.namespacePresence.shift() ?? false);
    },
    waitBeforeObservation: () => {
      state.events.push("wait");
      return Promise.resolve();
    },
  };
}

function state(
  observations: ControllerObservation[] = [],
  namespacePresence: boolean[] = [],
): FakeState {
  return { events: [], observations, namespacePresence };
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The regression-only group shares one fake Temporal state machine whose event order is the contract under test.
describe("run lifecycle activities", () => {
  it("creates one controller attempt and waits for its successful Job", async () => {
    const current = state([
      { _tag: "running" },
      { _tag: "succeeded", result: PROGRAM_RESULT },
    ]);
    const activities = makeRunLifecycleActivitiesWith(fakeOperations(current));

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      PROGRAM_RESULT,
    );
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
      "wait",
      "observe-controller",
    ]);
  });

  it("returns a closed failed result from a nonzero controller Job", async () => {
    const current = state([
      {
        _tag: "failed",
        detail: "controller Job failed",
        result: FAILED_RESULT,
      },
    ]);
    const activities = makeRunLifecycleActivitiesWith(fakeOperations(current));

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      FAILED_RESULT,
    );
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
    ]);
  });

  it("fails the workflow activity with the retained controller diagnostic", async () => {
    const current = state([
      { _tag: "failed", detail: "controller Job failed\napplication failed" },
    ]);
    const activities = makeRunLifecycleActivitiesWith(fakeOperations(current));

    await expect(activities.runControllerOnce(INPUT)).rejects.toMatchObject({
      name: "ControllerAttemptFailed",
      message: "controller Job failed\napplication failed",
    });
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "observe-controller",
    ]);
  });

  it("deletes the namespace idempotently and waits until it is absent", async () => {
    const current = state([], [true, true, false]);
    const activities = makeRunLifecycleActivitiesWith(fakeOperations(current));

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

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after Temporal activity assertions. */
/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test requirements after the Temporal lifecycle regressions. */
