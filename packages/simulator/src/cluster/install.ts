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

/** Environment variable that lets an operator roll the worker regardless. */
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

/** What the run-lifecycle task queue says about work it has not finished. */
export type OpenRunReading =
  | { readonly _tag: "open"; readonly workflowIds: readonly string[] }
  | { readonly _tag: "unreadable" };

/** One submission's request that the cluster's worker serve its image. */
export interface RunWorkerInstallRequest {
  /** The image this submission would have the worker run. */
  readonly desiredImage: string;
  /**
   * The queue's open work, read only when the installed image would change.
   *
   * A submission installing the image already running applies a Pod template
   * the cluster already has, which rolls nothing, so it has no reason to ask
   * Temporal anything — and no reason to fail when Temporal cannot answer.
   */
  readonly readOpenRuns: () => Effect.Effect<OpenRunReading>;
  /** Whether the operator has accepted losing whatever a roll interrupts. */
  readonly forced: boolean;
}

/** The installed worker never became able to serve the run-lifecycle queue. */
export class RunWorkerUnavailable extends Error {
  override readonly name = "RunWorkerUnavailable";

  constructor() {
    super("the run worker did not become available");
  }
}

/* eslint-disable agent-code-guard/max-non-trivial-classes-per-file -- a worker that never came up and a worker that must not be replaced yet are the two ways this one install refuses to hand a submission to the queue */
/** Installing would replace a worker that still owes results to open runs. */
export class RunWorkerRollRefused extends Error {
  override readonly name = "RunWorkerRollRefused";

  constructor(detail: string) {
    super(
      `${detail}. Wait for those runs to finish, or set ${FORCE_WORKER_ROLL_VARIABLE}=1 to roll the worker anyway and lose them`,
    );
  }
}
/* eslint-enable agent-code-guard/max-non-trivial-classes-per-file -- Restore the one-class rule after the install's second refusal. */

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
      // Named so that a submission stuck here is legible from its output alone
      // rather than from a cluster the operator has to go and inspect.
      yield* Effect.logInfo(
        `awaiting worker availability ${String(attempt + 1)}/${String(AVAILABILITY_ATTEMPTS)}`,
      );
      if (workerIsAvailable(yield* api.readWorkerAvailability())) {
        return;
      }
      yield* api.wait(AVAILABILITY_INTERVAL_MS);
    }
    yield* Effect.fail(new RunWorkerUnavailable());
  });
}

/**
 * State the refusal reports, or nothing when installing interrupts no run.
 * @param installedImage Image the worker the cluster already has is running.
 * @param request The image this submission wants and how it reads open work.
 * @param reading What Temporal answered about the queue's unfinished runs.
 * @returns The operator-facing reason to refuse, or nothing to proceed.
 */
function interruptedRuns(
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

// Reading the installed image and applying the new one are two calls, so a run
// submitted between them is still rolled over. That window is accepted: these
// clusters have one operator, and closing it needs a lock the cluster does not
// offer. The image is also the only part of the Pod template compared, so a
// change to the template that keeps the image — a new grace period, say — rolls
// the worker without asking.
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
    const detail = interruptedRuns(
      installedImage,
      request,
      yield* request.readOpenRuns(),
    );
    if (detail !== undefined) {
      yield* Effect.fail(new RunWorkerRollRefused(detail));
    }
  });
}

/**
 * Install the cluster's run-lifecycle worker and wait until it can poll.
 *
 * Every submission installs it, because the worker runs the image the submitter
 * selected and a cluster prepared before that image existed has no worker at
 * all. The one submission that must not is the one whose image differs from the
 * installed one while that worker still owns runs: rolling the Deployment
 * deletes the only Pod heartbeating those activities, which fails them and
 * takes their namespaces with them.
 *
 * @param api Host-side access to the profile's cluster.
 * @param request The submission's image, its open-run reading, and any override.
 * @returns Nothing once one worker replica is available on the task queue.
 * @failure KubernetesCallFailed when a control-plane object could not be written.
 * @failure RunWorkerRollRefused when installing would interrupt an open run.
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
    Effect.zipRight(Effect.logInfo("applying run-worker manifests")),
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
