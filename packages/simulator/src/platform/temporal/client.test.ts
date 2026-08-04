/* eslint-disable agent-code-guard/async-keyword -- Temporal client tests await the SDK's Promise-native boundary. */

import type { WorkflowClient } from "@temporalio/client";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CompletedLedgerReceipt } from "../../kernel/run.js";
import {
  LedgerCompletion,
  ledgerDigest,
  ledgerRef,
} from "../../ledger/model.js";
import { programFinishedSummary } from "../controller/summary.js";
import { executeRunSocietyWorkflow } from "./client.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";

const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: "registry/controller@sha256:controller",
  supportImage: "registry/support@sha256:support",
  experimentModule: "export const runSpec = society;",
};
const DIGEST = Schema.decodeSync(ledgerDigest)("c".repeat(64));
const RESULT: RunControllerResult = {
  exitCode: 0,
  summary: programFinishedSummary(
    CompletedLedgerReceipt.make({
      ledger: Schema.decodeSync(ledgerRef)("temporal-client-ledger"),
      completion: LedgerCompletion.make({
        ledgerFormatVersion: 1,
        runId: "temporal-client-run",
        recordCount: 4,
        artifacts: { manifest: DIGEST, records: DIGEST },
      }),
    }),
  ),
};

describe("executeRunSocietyWorkflow", () => {
  it("starts one caller-identified workflow and waits for its result", async () => {
    const execute = vi
      .fn<WorkflowClient["execute"]>()
      .mockResolvedValue(RESULT);
    const client: Pick<WorkflowClient, "execute"> = { execute };

    await expect(
      executeRunSocietyWorkflow(INPUT, {
        client,
        workflowId: "workflow-run-1",
        taskQueue: "moltzap-simulator",
      }),
    ).resolves.toEqual(RESULT);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("runSocietyWorkflow", {
      workflowId: "workflow-run-1",
      taskQueue: "moltzap-simulator",
      args: [INPUT],
    });
  });
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after the Temporal client boundary. */
