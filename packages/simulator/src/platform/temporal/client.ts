/** @file Client call that starts and awaits one coarse simulator workflow. */

import type { WorkflowClient } from "@temporalio/client";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";
import type { runSocietyWorkflow } from "./workflow.js";

const WORKFLOW_TYPE = "runSocietyWorkflow";

/** Caller-owned identity and queue for a single workflow execution. */
export interface RunSocietyWorkflowExecutionOptions {
  readonly client: Pick<WorkflowClient, "execute">;
  readonly workflowId: string;
  readonly taskQueue: string;
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Temporal clients expose a native Promise API. */

/**
 * Start exactly one workflow execution and wait for its controller result.
 * @param input Serializable controller input carried by the workflow.
 * @param options Caller-selected Temporal client, identity, and task queue.
 * @returns The successful controller activity result.
 */
export async function executeRunSocietyWorkflow(
  input: RunSocietyWorkflowInput,
  options: RunSocietyWorkflowExecutionOptions,
): Promise<RunControllerResult> {
  return await options.client.execute<typeof runSocietyWorkflow>(
    WORKFLOW_TYPE,
    {
      workflowId: options.workflowId,
      taskQueue: options.taskQueue,
      args: [input],
    },
  );
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-first application rules after the Temporal client boundary. */
