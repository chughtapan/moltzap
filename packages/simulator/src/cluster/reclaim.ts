/** @file Run the controller once, then always tear the run's cluster state down. */

import {
  ApplicationFailure,
  CancellationScope,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
// safer-arch-ignore no-upward-layer-import: the controller's serializable run summary is the contract this workflow carries back to its caller, so the summary shape is owned where the controller writes it.
import type { ControllerRunResult } from "./controller/summary.js";

/**
 * The controller's coarse result, taken by cluster modules through this one
 * waived crossing rather than each importing the controller layer.
 */
export type { ControllerRunResult } from "./controller/summary.js";

/** Private data needed to start one in-cluster experiment controller. */
export interface RunSocietyWorkflowInput {
  readonly runId: string;
  readonly namespace: string;
  readonly controllerImage: string;
  readonly supportImage: string;
  /** Complete agent image selected for an environment-driven experiment. */
  readonly applicationImage?: string;
  /** Provider credentials retained only for the transient controller Job. */
  readonly runtimeCredentials?: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  /** Complete `.mjs` source mounted into the controller Job. */
  readonly experimentModule: string;
  /** Budget for a cohort to become ready, when the default is too small. */
  readonly startupTimeoutMs?: number;
  /**
   * Budget for the queue to admit the cohort's capacity, kept apart from the
   * readiness budget because a cohort waiting behind other runs has not begun
   * to start.
   */
  readonly admissionTimeoutMs?: number;
  /** Agents an experiment sizes its roster from, when its run chooses. */
  readonly cohortSize?: number;
}

/** Identity sufficient for idempotent deletion of one run's resources. */
export type CleanupRunInput = Readonly<
  Pick<RunSocietyWorkflowInput, "runId" | "namespace">
>;

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal activity implementations are Promise-native functions consumed directly by proxyActivities. */
/** Activities owned by the worker for one complete run lifecycle. */
export interface RunLifecycleActivities {
  readonly runControllerOnce: (
    input: RunSocietyWorkflowInput,
  ) => Promise<ControllerRunResult>;
  readonly cleanupRun: (input: CleanupRunInput) => Promise<void>;
  readonly stopController: (input: CleanupRunInput) => Promise<void>;
}
/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first contract rules after the Temporal activity boundary. */

const { runControllerOnce } = proxyActivities<
  Pick<RunLifecycleActivities, "runControllerOnce">
>({
  startToCloseTimeout: "24 hours",
  // A controller Job may legitimately occupy the activity for hours, so the
  // start-to-close deadline cannot distinguish a long run from a worker that
  // died holding it. The heartbeat deadline is what fails the attempt within a
  // minute, which is what lets the cleanup below reclaim the run's namespace.
  heartbeatTimeout: "60 seconds",
  // A second attempt would re-run the experiment's Effect from the start.
  retry: { maximumAttempts: 1 },
});

const { cleanupRun } = proxyActivities<
  Pick<RunLifecycleActivities, "cleanupRun">
>({
  startToCloseTimeout: "10 minutes",
});

const cancelEvaluation = defineSignal("cancelEvaluation");
/** Retry through cold startup; the owning scope cancels retries once the controller ends. */
const { stopController } = proxyActivities<
  Pick<RunLifecycleActivities, "stopController">
>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "5 seconds" },
});

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal workflow entrypoints must use the SDK's own Promise-returning contract. */
/**
 * Runs one controller attempt and shields its final cleanup from cancellation.
 *
 * This module is bundled into the deterministic workflow sandbox, so it carries
 * the activity contract as types and reaches every implementation through
 * `proxyActivities`. A value import of the activity, Kubernetes, or Node
 * surfaces would put non-deterministic code inside that bundle.
 *
 * @param input Private run identity and controller artifacts.
 * @returns The controller's operational success after cleanup completes.
 */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal workflows are SDK-required Promise boundaries
export async function runSocietyWorkflow(
  input: RunSocietyWorkflowInput,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal workflows are SDK-required Promise boundaries
): Promise<ControllerRunResult> {
  // #ignore-sloppy-code-next-line[promise-type]: Temporal signal handlers share the SDK-owned pending activity promise
  let stop: Promise<void> | undefined;
  let stopAccepted = false;
  let controllerFinished = false;
  const stopScope = new CancellationScope({ cancellable: true });
  setHandler(cancelEvaluation, () => {
    if (controllerFinished) {
      return;
    }
    // eslint-disable-next-line agent-code-guard/then-chain -- Temporal signal handlers use workflow-native Promises, not an Effect runtime.
    stop ??= stopScope
      .run(() =>
        stopController({ runId: input.runId, namespace: input.namespace }),
      )
      // #ignore-sloppy-code-next-line[then-chain]: Temporal workflow signal handlers compose SDK-native activity promises
      .then(() => {
        stopAccepted = true;
      })
      .catch((error: unknown) => {
        if (!controllerFinished) {
          log.warn("Controller stop request failed", { error });
        }
      });
    return stop;
  });
  let result: ControllerRunResult | undefined;
  let controllerFailure: Error | undefined;
  try {
    result = await runControllerOnce(input);
  } catch (error) {
    controllerFailure =
      error instanceof Error
        ? error
        : ApplicationFailure.nonRetryable(
            String(error),
            "ControllerWorkflowFailure",
          );
  }
  controllerFinished = true;
  if (stop !== undefined) {
    await finishStopRequest(stopScope, stop);
  }
  const cleanupFailed = await cleanupCompletedRun(input);
  return workflowResult(cleanupFailed, stopAccepted, result, controllerFailure);
}

/** Cleanup failure remains independent of controller evidence; activity history retains its detail. */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal cleanup activities use the SDK's Promise-native workflow boundary
async function cleanupCompletedRun(input: CleanupRunInput) {
  try {
    await CancellationScope.nonCancellable(() =>
      cleanupRun({ runId: input.runId, namespace: input.namespace }),
    );
    return false;
  } catch (error) {
    log.warn("Run cleanup failed", { error });
    return true;
  }
}

/** Joining the cancelled request prevents an unfinished signal handler from outliving cleanup. */
// #ignore-sloppy-code-next-line[async-keyword]: Temporal cancellation scopes use the SDK's Promise-native workflow boundary
async function finishStopRequest(
  scope: CancellationScope,
  // #ignore-sloppy-code-next-line[promise-type]: Temporal cancellation scope joins an SDK-owned activity promise
  pending: Promise<void>,
) {
  scope.cancel();
  await CancellationScope.nonCancellable(() => pending);
}
/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first function rules after the Temporal workflow entrypoint. */

function workflowResult(
  cleanupFailed: boolean,
  stopAccepted: boolean,
  result?: ControllerRunResult,
  controllerFailure?: Error,
): ControllerRunResult {
  if (controllerFailure !== undefined) {
    throw controllerFailure;
  }
  if (result === undefined) {
    throw ApplicationFailure.nonRetryable(
      "Controller produced no result",
      "ControllerWorkflowFailure",
    );
  }
  return {
    ...result,
    ...(stopAccepted && result.exitCode === 1
      ? { cancelled: true as const }
      : {}),
    cleanup: cleanupFailed ? "failed" : "complete",
  };
}
