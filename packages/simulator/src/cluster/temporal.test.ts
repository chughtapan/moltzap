/* eslint-disable agent-code-guard/async-keyword -- Temporal activity and client tests await the SDK's Promise-native boundary. */
/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only activity timelines pin one Temporal attempt and cleanup ordering. */

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The symlinked-release fixture mirrors an image layout, and the guard under test is itself synchronous and Effect-free.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  isEntryModule,
  LifecycleOperations,
  runLifecycleActivities,
  type ControllerObservation,
  type LifecycleOperationsService,
  type RunSocietyWorkflowExecutionOptions,
} from "./temporal.js";

/** The exact client surface the module under test asks a caller to supply. */
type WorkflowExecutor = RunSocietyWorkflowExecutionOptions["client"];

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
    heartbeat: () => {
      state.events.push("heartbeat");
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
  it("creates one controller attempt and waits for its successful Job", async () => {
    const current = state([
      { _tag: "running" },
      { _tag: "succeeded", result: PROGRAM_RESULT },
    ]);
    const activities = fakeActivities(current);

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      PROGRAM_RESULT,
    );
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "heartbeat",
      "observe-controller",
      "wait",
      "heartbeat",
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
    const activities = fakeActivities(current);

    await expect(activities.runControllerOnce(INPUT)).resolves.toEqual(
      FAILED_RESULT,
    );
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "heartbeat",
      "observe-controller",
    ]);
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
    expect(current.events).toEqual([
      `prepare:${INPUT.namespace}`,
      "heartbeat",
      "observe-controller",
    ]);
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

interface WorkerLayout {
  /** Real path of the worker module, as Node reports it in import.meta.url. */
  readonly real: string;
  /** The same module reached through a symlinked parent directory. */
  readonly linked: string;
  /** A sibling module that is never the entry point. */
  readonly sibling: string;
}

function workerLayout(): WorkerLayout {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moltzap-entry-")));
  const release = join(root, "release-2026-08-04");
  mkdirSync(release);
  writeFileSync(join(release, "temporal.js"), "");
  writeFileSync(join(release, "reclaim.js"), "");
  symlinkSync(release, join(root, "current"), "dir");
  return {
    real: join(release, "temporal.js"),
    linked: join(root, "current", "temporal.js"),
    sibling: join(release, "reclaim.js"),
  };
}

describe("isEntryModule", () => {
  it("recognizes the worker reached through a symlinked directory", () => {
    const layout = workerLayout();

    expect(isEntryModule(pathToFileURL(layout.real).href, layout.linked)).toBe(
      true,
    );
  });

  it("recognizes the worker reached by its own real path", () => {
    const layout = workerLayout();

    expect(isEntryModule(pathToFileURL(layout.real).href, layout.real)).toBe(
      true,
    );
  });

  it("rejects a different module and a process with no entry path", () => {
    const layout = workerLayout();

    expect(isEntryModule(pathToFileURL(layout.real).href, layout.sibling)).toBe(
      false,
    );
    expect(isEntryModule(pathToFileURL(layout.real).href)).toBe(false);
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after Temporal activity and client assertions. */
/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test requirements after the Temporal lifecycle regressions. */
