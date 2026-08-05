/* eslint-disable agent-code-guard/async-keyword -- The activity boundary under test is Promise-native, so its double keeps the same signatures. */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
} from "../run/execute.js";
import { LedgerCompletion, ledgerDigest, ledgerRef } from "../ledger/schema.js";
import {
  encodeControllerRunSummary,
  programFinishedSummary,
  clusterLostSummary,
  type ControllerRunSummary,
} from "./controller/summary.js";
import type {
  JobCondition,
  JobObservation,
  RunControlApi,
} from "./kubernetes/calls.js";
import type { RunSocietyWorkflowInput } from "./reclaim.js";
import {
  controllerObservation,
  observeController,
  sanitizeControllerDiagnostic,
} from "./watch.js";

const DIGEST = Schema.decodeSync(ledgerDigest)("d".repeat(64));
const LEDGER = Schema.decodeSync(ledgerRef)("temporal-kubernetes-ledger");
const PROGRAM_SUMMARY = programFinishedSummary(
  CompletedLedgerReceipt.make({
    ledger: LEDGER,
    completion: LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: "temporal-kubernetes-run",
      recordCount: 5,
      artifacts: { manifest: DIGEST, records: DIGEST },
    }),
  }),
);
const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: "registry/controller@sha256:controller",
  supportImage: "registry/support@sha256:support",
  experimentModule: "export const runSpec = society;",
};

function job(
  status: Partial<JobObservation> & { conditions?: readonly JobCondition[] },
): JobObservation {
  return {
    succeeded: 0,
    failed: 0,
    active: 0,
    conditions: [],
    ...status,
  };
}

function encodedSummary(summary: ControllerRunSummary): string {
  const encoded = encodeControllerRunSummary(summary);
  expect(encoded).toBeDefined();
  return encoded ?? "";
}

/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only cases pin bounded projection of third-party Kubernetes Job status and logs. */

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The regression-only group is one closed Job-status and controller-summary decision table.
describe("controller Job diagnostics", () => {
  it("keeps useful failure output while removing credentials and control bytes", () => {
    const observation = controllerObservation(
      job({
        failed: 1,
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: "BackoffLimitExceeded",
            message: "controller exited",
          },
        ],
      }),
      "starting experiment\nregistrationSecret=do-not-retain\n\u001b[31mrun failed\u001b[0m\u0007",
    );

    expect(observation).toEqual({
      _tag: "failed",
      detail: [
        "controller Job failed",
        "BackoffLimitExceeded: controller exited",
        "starting experiment",
        "[redacted credential-bearing log line]",
        "run failed",
      ].join("\n"),
    });
  });

  it("distinguishes active and completed Jobs", () => {
    expect(controllerObservation(job({ active: 1 }))).toEqual({
      _tag: "running",
    });
    expect(
      controllerObservation(
        job({ succeeded: 1 }),
        encodedSummary(PROGRAM_SUMMARY),
      ),
    ).toEqual({
      _tag: "succeeded",
      result: { exitCode: 0, summary: PROGRAM_SUMMARY },
    });
  });

  it("keeps a Job with a failed attempt still running while one is active", () => {
    expect(controllerObservation(job({ failed: 1, active: 1 }))).toEqual({
      _tag: "running",
    });
  });

  it("retains a receipt from a nonzero cluster outcome", () => {
    const summary = clusterLostSummary(
      IncompleteLedgerReceipt.make({ ledger: LEDGER }),
    );

    expect(
      controllerObservation(
        job({ failed: 1 }),
        `${encodedSummary(summary)}\nSimulator controller execution failed`,
      ),
    ).toEqual({
      _tag: "failed",
      detail: "controller Job failed\nSimulator controller execution failed",
      result: { exitCode: 1, summary },
    });
  });

  it("rejects a terminal Job without a matching closed result", () => {
    expect(controllerObservation(job({ succeeded: 1 }))).toEqual({
      _tag: "failed",
      detail: "controller Job completed without a valid result summary",
    });
    expect(
      controllerObservation(
        job({ failed: 1 }),
        encodedSummary(PROGRAM_SUMMARY),
      ),
    ).toEqual({
      _tag: "failed",
      detail: "controller Job failed",
    });
  });

  it("bounds retained output to the diagnostic limit", () => {
    expect(sanitizeControllerDiagnostic("x".repeat(8_192))).toHaveLength(4_096);
  });
});

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore generative-test requirements after the Kubernetes projection regressions. */

function observing(observed: JobObservation, logs?: string) {
  const reads: string[] = [];
  const api: RunControlApi = {
    createRunRoot: () => Promise.reject(new Error("observing creates nothing")),
    createExperimentAndQueue: () => Promise.resolve(),
    createControllerAccess: () => Promise.resolve(),
    createRouterService: () => Promise.resolve(),
    startController: () => Promise.resolve(),
    readControllerJob: () => Promise.resolve(observed),
    readControllerLogs: (namespace, tailLines, limitBytes) => {
      reads.push(`${namespace}:${String(tailLines)}:${String(limitBytes)}`);
      return Promise.resolve(logs);
    },
    deleteRunNamespace: () => Promise.resolve(),
    runNamespaceExists: () => Promise.resolve(false),
  };
  return { api, reads };
}

it("spends no Pod-log read on a Job that is still running", async () => {
  const { api, reads } = observing(job({ active: 1 }));

  await expect(observeController(api, INPUT)).resolves.toEqual({
    _tag: "running",
  });

  expect(reads).toEqual([]);
});

it("reads a bounded log tail once the Job is terminal", async () => {
  const { api, reads } = observing(
    job({ succeeded: 1 }),
    encodedSummary(PROGRAM_SUMMARY),
  );

  await expect(observeController(api, INPUT)).resolves.toEqual({
    _tag: "succeeded",
    result: { exitCode: 0, summary: PROGRAM_SUMMARY },
  });

  expect(reads).toEqual([`${INPUT.namespace}:200:8192`]);
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after the Promise-native activity contract. */
