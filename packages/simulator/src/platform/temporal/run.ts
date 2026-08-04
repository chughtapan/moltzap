/** @file Host-side glue for one local Temporal-managed simulator run. */

import { Client } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { makeKubernetesRunLifecycleActivities } from "./activities.js";
import { executeRunSocietyWorkflow } from "./client.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";
import { createRunSocietyWorker } from "./worker.js";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "../kubernetes/profile.js";

/** Host profile inputs for one workflow, with identity selected by the caller. */
export interface RunTemporalSocietyOptions {
  readonly input: RunSocietyWorkflowInput;
  readonly executionProfile?: KubernetesExecutionProfile;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly temporalAddress?: string;
  readonly temporalNamespace?: string;
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- This private host entry point composes Temporal's Promise-native client and worker APIs. */

/**
 * Run one workflow on an in-process worker, then release its Temporal connection.
 * @param options Temporal endpoint plus caller-owned workflow and run inputs.
 * @returns The successful controller activity result.
 */
export async function runTemporalSociety(
  options: RunTemporalSocietyOptions,
): Promise<RunControllerResult> {
  const connection = await NativeConnection.connect(
    options.temporalAddress === undefined
      ? undefined
      : { address: options.temporalAddress },
  );
  try {
    const namespace = options.temporalNamespace ?? "default";
    const worker = await createRunSocietyWorker({
      connection,
      namespace,
      taskQueue: options.taskQueue,
      activities: makeKubernetesRunLifecycleActivities(
        options.executionProfile ?? LOCAL_KUBERNETES_EXECUTION_PROFILE,
      ),
    });
    const client = new Client({ connection, namespace });
    return await worker.runUntil(() =>
      executeRunSocietyWorkflow(options.input, {
        client: client.workflow,
        taskQueue: options.taskQueue,
        workflowId: options.workflowId,
      }),
    );
  } finally {
    await connection.close();
  }
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-first application rules after the Temporal host boundary. */
