/** @file Install the cluster's run-lifecycle worker and wait until it polls. */

import type {
  RunWorkerInstallApi,
  RunWorkerObject,
  WorkerAvailability,
} from "./kubernetes/calls.js";

const AVAILABILITY_ATTEMPTS = 150;
const AVAILABILITY_INTERVAL_MS = 2_000;

// Identity before permissions, permissions before the workload that uses them.
// A Deployment installed ahead of its ClusterRoleBinding starts a Pod whose
// service account cannot delete a run namespace, which is the one thing the
// worker exists to do, and Kubernetes reports that as a permission error on a
// run rather than as a failed install.
const INSTALL_ORDER: readonly RunWorkerObject[] = [
  "namespace",
  "serviceAccount",
  "clusterRole",
  "clusterRoleBinding",
  "deployment",
];

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Installation happens at the host's Promise-native Kubernetes boundary, before any Effect runtime exists. */

/** The installed worker never became able to serve the run-lifecycle queue. */
export class RunWorkerUnavailable extends Error {
  override readonly name = "RunWorkerUnavailable";

  constructor() {
    super("the run worker did not become available");
  }
}

/**
 * Whether the rollout the cluster reports is the installed one and is serving.
 *
 * `observedGeneration` is what separates a worker that is up from the previous
 * revision of a worker that is being replaced: until the controller has caught
 * up to the generation just installed, `availableReplicas` still describes the
 * image the last submission chose.
 *
 * @param availability Rollout state read back from the installed Deployment.
 * @returns Whether at least one replica of the installed revision is available.
 */
export function workerIsAvailable(availability: WorkerAvailability): boolean {
  return (
    availability.observedGeneration >= availability.generation &&
    availability.availableReplicas > 0
  );
}

// A worker that never becomes available is the one failure mode that would
// otherwise be silent: the workflow starts, nothing polls its task queue, and
// the submitter waits forever. Waiting here turns that into a failed submission.
async function awaitAvailableWorker(api: RunWorkerInstallApi): Promise<void> {
  for (let attempt = 0; attempt < AVAILABILITY_ATTEMPTS; attempt += 1) {
    if (workerIsAvailable(await api.readWorkerAvailability())) {
      return;
    }
    await api.wait(AVAILABILITY_INTERVAL_MS);
  }
  throw new RunWorkerUnavailable();
}

/**
 * Install the cluster's run-lifecycle worker and wait until it can poll.
 *
 * Every submission installs it, because the worker runs the image the submitter
 * selected and a cluster prepared before that image existed has no worker at
 * all.
 *
 * @param api Host-side access to the profile's cluster.
 * @returns Nothing once one worker replica is available on the task queue.
 * @failure RunWorkerUnavailable when no replica becomes available in time.
 */
export async function installRunWorker(
  api: RunWorkerInstallApi,
): Promise<void> {
  for (const object of INSTALL_ORDER) {
    await api.install(object);
  }
  await awaitAvailableWorker(api);
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Kubernetes host boundary. */
