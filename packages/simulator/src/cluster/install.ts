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

/** Environment variable that explicitly permits an interrupting worker roll. */
export const FORCE_WORKER_ROLL_VARIABLE = "MOLTZAP_FORCE_WORKER_ROLL";

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

/** What the run-lifecycle task queue says about unfinished work. */
export type OpenRunReading =
  | { readonly _tag: "open"; readonly workflowIds: readonly string[] }
  | { readonly _tag: "unreadable" };

/** One submission's request that the cluster worker serve its image. */
export interface RunWorkerInstallRequest {
  /** Image this submission needs the worker to run. */
  readonly desiredImage: string;
  /** Read unfinished work only when changing the installed image would roll. */
  readonly readOpenRuns: () => Effect.Effect<OpenRunReading>;
  /** Whether the operator explicitly accepts interrupting unfinished work. */
  readonly forced: boolean;
}

/** The installed worker never became able to serve the run-lifecycle queue. */
export class RunWorkerUnavailable extends Error {
  override readonly name = "RunWorkerUnavailable";

  constructor() {
    super("the run worker did not become available");
  }
}

/* eslint-disable agent-code-guard/max-non-trivial-classes-per-file -- installation can fail because the worker never starts or because replacing it would interrupt a run */
/** Installing would replace a worker that still owns unfinished runs. */
export class RunWorkerRollRefused extends Error {
  override readonly name = "RunWorkerRollRefused";

  constructor(detail: string) {
    super(
      `${detail}. Wait for those runs to finish, or set ${FORCE_WORKER_ROLL_VARIABLE}=1 to roll the worker anyway and lose them`,
    );
  }
}
/* eslint-enable agent-code-guard/max-non-trivial-classes-per-file -- Restore the one-class rule outside the installer's two refusal types. */

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

function interruptionDetail(
  installedImage: string,
  request: RunWorkerInstallRequest,
  reading: OpenRunReading,
): string | undefined {
  const roll = `installing ${request.desiredImage} replaces the run worker now serving ${installedImage}`;
  if (reading._tag === "unreadable") {
    return `${roll}, and whether any run is still open on its task queue could not be read`;
  }
  if (reading.workflowIds.length === 0) {
    return undefined;
  }
  return `${roll} while ${String(reading.workflowIds.length)} run(s) are still open on its task queue (${reading.workflowIds.join(", ")})`;
}

/**
 * Install the cluster's run-lifecycle worker and wait until it can poll.
 *
 * Every submission installs it, because the worker runs the image the submitter
 * selected and a cluster prepared before that image existed has no worker at
 * all. It refuses an image-changing rollout while the installed worker still
 * owns unfinished runs.
 *
 * @param api Host-side access to the profile's cluster.
 * @param request Desired image, unfinished-work reader, and operator override.
 * @returns Nothing once one worker replica is available on the task queue.
 * @failure KubernetesCallFailed when a control-plane object could not be written.
 * @failure RunWorkerRollRefused when installing would interrupt unfinished work.
 * @failure RunWorkerUnavailable when no replica becomes available in time.
 */
export function installRunWorker(
  api: RunWorkerInstallApi,
  request: RunWorkerInstallRequest,
): Effect.Effect<
  void,
  KubernetesCallFailed | RunWorkerRollRefused | RunWorkerUnavailable
> {
  return guardWorkerRoll(api, request).pipe(
    Effect.zipRight(
      Effect.forEach(INSTALL_ORDER, (object) => api.install(object), {
        concurrency: 1,
        discard: true,
      }),
    ),
    Effect.zipRight(awaitAvailableWorker(api)),
    Effect.withSpan("installRunWorker"),
  );
}

/**
 * Refuse an image-changing apply while the installed worker owns unfinished
 * runs. The image read and apply are separate Kubernetes calls, so this guard
 * assumes submissions to a cluster are serialized by its operator.
 * @param api Host-side reader and installer for the worker Deployment.
 * @param request Desired image, unfinished-work reader, and override policy.
 * @returns Nothing when applying the requested image is safe or forced.
 */
function guardWorkerRoll(
  api: RunWorkerInstallApi,
  request: RunWorkerInstallRequest,
): Effect.Effect<void, KubernetesCallFailed | RunWorkerRollRefused> {
  return Effect.gen(function* () {
    const installedImage = yield* api.readInstalledWorkerImage();
    if (
      installedImage === undefined ||
      installedImage === request.desiredImage
    ) {
      return;
    }
    if (request.forced) {
      yield* Effect.logWarning(
        `${FORCE_WORKER_ROLL_VARIABLE} is set: rolling the run worker without asking what it would interrupt`,
      );
      return;
    }
    const detail = interruptionDetail(
      installedImage,
      request,
      yield* request.readOpenRuns(),
    );
    if (detail !== undefined) {
      yield* Effect.fail(new RunWorkerRollRefused(detail));
    }
  });
}
