/** @file Controller Job state, result-marker, and bounded redacted diagnostic regressions. */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RunSocietyWorkflowInput } from "./reclaim.js";
import { LedgerCompletion, ledgerDigest, ledgerRef } from "../ledger/schema.js";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
} from "../run/execute.js";
import {
  clusterLostSummary,
  type ControllerRunSummary,
  encodeControllerRunSummary,
  programFinishedSummary,
} from "./controller/summary.js";
import {
  type JobCondition,
  type JobObservation,
  KubernetesCallFailed,
  type RunControlApi,
} from "./kubernetes/calls.js";
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

const REDACTED_LINE = "[redacted credential-bearing log line]";
const LEAKED_VALUE = "do-not-retain";

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

  /**
   * All but the last two lines carry exactly one sensitive word and mention no
   * token, secret, password, or key, so each survives unless the pattern knows
   * that word. The last two are the shape a real leak takes.
   */
  it.each([
    `CODEX_AUTH_JSON={"account_id":"${LEAKED_VALUE}"}`,
    `codex auth-json payload ${LEAKED_VALUE}`,
    `codex AUTH JSON payload ${LEAKED_VALUE}`,
    `authjson=${LEAKED_VALUE}`,
    `read /var/run/moltzap/bootstrap/state/.codex/auth.json: ${LEAKED_VALUE}`,
    `forwarding credential ${LEAKED_VALUE} to alice`,
    `CREDENTIALS: ${LEAKED_VALUE}`,
    `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-${LEAKED_VALUE}`,
    `CODEX_AUTH_JSON={"tokens":{"access_token":"${LEAKED_VALUE}"}}`,
  ])("redacts a line naming a credential or a Codex login: %s", (line) => {
    const retained = sanitizeControllerDiagnostic(
      ["starting experiment", line, "run failed"].join("\n"),
    );

    expect(retained).toBe(
      ["starting experiment", REDACTED_LINE, "run failed"].join("\n"),
    );
    expect(retained).not.toContain(LEAKED_VALUE);
  });

  it("retains a line that only resembles a Codex login name", () => {
    expect(sanitizeControllerDiagnostic("authored 3 json files")).toBe(
      "authored 3 json files",
    );
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
      _tag: "completed",
      result: { exitCode: 0, summary: PROGRAM_SUMMARY },
    });
  });

  it("keeps a Job with a failed attempt still running while one is active", () => {
    expect(controllerObservation(job({ failed: 1, active: 1 }))).toEqual({
      _tag: "running",
    });
  });

  it("retains interruption evidence when the controller handles SIGTERM and exits zero", () => {
    const summary = clusterLostSummary(PROGRAM_SUMMARY.receipt);
    expect(
      controllerObservation(job({ succeeded: 1 }), encodedSummary(summary)),
    ).toEqual({ _tag: "completed", result: { exitCode: 1, summary } });
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
      // A decodable failure summary is a completed observation: the activity
      // returns it rather than failing, so the reason the Job gave rides the
      // result or disappears with the namespace.
    ).toEqual({
      _tag: "completed",
      result: {
        exitCode: 1,
        summary,
        diagnostic:
          "controller Job failed\nSimulator controller execution failed",
      },
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

function observing(observed: JobObservation, logs?: string) {
  const reads: string[] = [];
  const api: RunControlApi = {
    createRunRoot: () =>
      Effect.fail(new KubernetesCallFailed("observing creates nothing")),
    createExperimentAndQueue: () => Effect.void,
    createControllerAccess: () => Effect.void,
    createControllerService: () => Effect.void,
    startController: () => Effect.void,
    readControllerJob: () => Effect.succeed(observed),
    readControllerLogs: (namespace, tailLines, limitBytes) =>
      Effect.sync(() => {
        reads.push(`${namespace}:${String(tailLines)}:${String(limitBytes)}`);
        return logs;
      }),
    requestControllerStop: () => Effect.void,
    deleteRunNamespace: () => Effect.void,
    runNamespaceExists: () => Effect.succeed(false),
  };
  return { api, reads };
}

it("spends no Pod-log read on a Job that is still running", async () => {
  const { api, reads } = observing(job({ active: 1 }));

  await expect(
    Effect.runPromise(observeController(api, INPUT)),
  ).resolves.toEqual({ _tag: "running" });

  expect(reads).toEqual([]);
});

it("reads a bounded log tail once the Job is terminal", async () => {
  const { api, reads } = observing(
    job({ succeeded: 1 }),
    encodedSummary(PROGRAM_SUMMARY),
  );

  await expect(
    Effect.runPromise(observeController(api, INPUT)),
  ).resolves.toEqual({
    _tag: "completed",
    result: { exitCode: 0, summary: PROGRAM_SUMMARY },
  });

  expect(reads).toEqual([`${INPUT.namespace}:200:8192`]);
});
