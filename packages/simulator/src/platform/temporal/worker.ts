/** @file Worker construction for the coarse simulator workflow. */

import { fileURLToPath } from "node:url";
import { Worker, type NativeConnection } from "@temporalio/worker";
import type { RunLifecycleActivities } from "./contract.js";

/** SDK objects needed to build a worker without selecting connection policy. */
export interface RunSocietyWorkerOptions {
  readonly connection: NativeConnection;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly activities: RunLifecycleActivities;
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Temporal workers expose a native Promise API. */

/**
 * Create a worker that registers only the coarse workflow and its two activities.
 * @param options Existing connection, namespace, queue, and activity implementations.
 * @returns A worker ready to poll the selected task queue.
 */
export async function createRunSocietyWorker(
  options: RunSocietyWorkerOptions,
): Promise<Worker> {
  return await Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    activities: options.activities,
    workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
  });
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Restore Effect-first application rules after the Temporal worker boundary. */
