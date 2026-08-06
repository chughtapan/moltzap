/** @file Install the cluster's run-lifecycle worker and wait until it polls. */

import { Effect } from "effect";
import type {
  KubernetesCallFailed,
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
 * Every submission installs the image it just built, so every submission rolls
 * the Deployment, and `availableReplicas` counts the outgoing revision too.
 * Treating that as readiness hands the workflow to a Pod the rollout deletes.
 *
 * @param availability Rollout state read back from the installed Deployment.
 * @returns Whether the installed revision is the only one still serving.
 */
export function workerIsAvailable(availability: WorkerAvailability): boolean {
  return (
    availability.observedGeneration >= availability.generation &&
    availability.updatedReplicas > 0 &&
    availability.replicas === availability.updatedReplicas &&
    availability.availableReplicas >= availability.updatedReplicas
  );
}

// A worker that never becomes available is the one failure mode that would
// otherwise be silent: the workflow starts, nothing polls its task queue, and
// the submitter waits forever. Waiting here turns that into a failed submission.
function awaitAvailableWorker(
  api: RunWorkerInstallApi,
): Effect.Effect<void, KubernetesCallFailed | RunWorkerUnavailable> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < AVAILABILITY_ATTEMPTS; attempt += 1) {
      if (workerIsAvailable(yield* api.readWorkerAvailability())) {
        return;
      }
      yield* api.wait(AVAILABILITY_INTERVAL_MS);
    }
    yield* Effect.fail(new RunWorkerUnavailable());
  });
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
 * @failure KubernetesCallFailed when a control-plane object could not be written.
 * @failure RunWorkerUnavailable when no replica becomes available in time.
 */
export function installRunWorker(
  api: RunWorkerInstallApi,
): Effect.Effect<void, KubernetesCallFailed | RunWorkerUnavailable> {
  return Effect.forEach(INSTALL_ORDER, (object) => api.install(object), {
    concurrency: 1,
    discard: true,
  }).pipe(
    Effect.zipRight(awaitAvailableWorker(api)),
    Effect.withSpan("installRunWorker"),
  );
}
