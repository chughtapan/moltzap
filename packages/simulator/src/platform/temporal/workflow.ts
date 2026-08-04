/** @file Deterministic coarse Temporal workflow for one simulator run. */

import { CancellationScope, proxyActivities } from "@temporalio/workflow";
import type {
  RunControllerResult,
  RunLifecycleActivities,
  RunSocietyWorkflowInput,
} from "./contract.js";

const { runControllerOnce } = proxyActivities<
  Pick<RunLifecycleActivities, "runControllerOnce">
>({
  startToCloseTimeout: "24 hours",
  retry: { maximumAttempts: 1 },
});

const { cleanupRun } = proxyActivities<
  Pick<RunLifecycleActivities, "cleanupRun">
>({
  startToCloseTimeout: "10 minutes",
});

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Temporal workflow entrypoints must use the SDK's native async Promise contract. */
/**
 * Runs one controller attempt and shields its final cleanup from cancellation.
 *
 * @param input Private run identity and controller artifacts.
 * @returns The controller's operational success after cleanup completes.
 */
export async function runSocietyWorkflow(
  input: RunSocietyWorkflowInput,
): Promise<RunControllerResult> {
  try {
    return await runControllerOnce(input);
  } finally {
    await CancellationScope.nonCancellable(() =>
      cleanupRun({ runId: input.runId, namespace: input.namespace }),
    );
  }
}
/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-first function rules after the Temporal workflow entrypoint. */
