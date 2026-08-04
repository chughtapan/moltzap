import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CompletedLedgerReceipt,
  IncompleteLedgerReceipt,
} from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import {
  encodeControllerRunSummary,
  programFinishedSummary,
  runInfrastructureFailedSummary,
  type ControllerRunSummary,
} from "../controller/summary.js";
import {
  controllerObservation,
  sanitizeControllerDiagnostic,
} from "./kubernetes.js";

/* eslint-disable agent-code-guard/no-example-only-tests -- Regression-only cases pin bounded projection of third-party Kubernetes Job status and logs. */

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

function encodedSummary(summary: ControllerRunSummary): string {
  const encoded = encodeControllerRunSummary(summary);
  expect(encoded).toBeDefined();
  return encoded ?? "";
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The regression-only group is one closed Job-status and controller-summary decision table.
describe("controller Job diagnostics", () => {
  it("keeps useful failure output while removing credentials and control bytes", () => {
    const observation = controllerObservation(
      {
        status: {
          failed: 1,
          conditions: [
            {
              type: "Failed",
              status: "True",
              reason: "BackoffLimitExceeded",
              message: "controller exited",
            },
          ],
        },
      },
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
    expect(controllerObservation({ status: { active: 1 } })).toEqual({
      _tag: "running",
    });
    expect(
      controllerObservation(
        { status: { succeeded: 1 } },
        encodedSummary(PROGRAM_SUMMARY),
      ),
    ).toEqual({
      _tag: "succeeded",
      result: { exitCode: 0, summary: PROGRAM_SUMMARY },
    });
  });

  it("retains a receipt from a nonzero infrastructure outcome", () => {
    const summary = runInfrastructureFailedSummary(
      IncompleteLedgerReceipt.make({ ledger: LEDGER }),
    );

    expect(
      controllerObservation(
        { status: { failed: 1 } },
        `${encodedSummary(summary)}\nSimulator controller execution failed`,
      ),
    ).toEqual({
      _tag: "failed",
      detail: "controller Job failed\nSimulator controller execution failed",
      result: { exitCode: 1, summary },
    });
  });

  it("rejects a terminal Job without a matching closed result", () => {
    expect(controllerObservation({ status: { succeeded: 1 } })).toEqual({
      _tag: "failed",
      detail: "controller Job completed without a valid result summary",
    });
    expect(
      controllerObservation(
        { status: { failed: 1 } },
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
