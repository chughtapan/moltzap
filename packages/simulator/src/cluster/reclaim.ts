/** @file Run the controller once, then always tear the run's cluster state down. */

import { CancellationScope, proxyActivities } from "@temporalio/workflow";
// safer-arch-ignore no-upward-layer-import: the controller's serializable run summary is the contract this workflow carries back to its caller, so the summary shape is owned where the controller writes it.
import type {
  ControllerFailedRunSummary,
  ControllerProgramFinishedSummary,
} from "./controller/summary.js";

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
  /** Agents an experiment sizes its roster from, when its run chooses. */
  readonly cohortSize?: number;
}

/** Identity sufficient for idempotent deletion of one run's resources. */
export type CleanupRunInput = Readonly<
  Pick<RunSocietyWorkflowInput, "runId" | "namespace">
>;

/**
 * Closed controller process result retained by the coarse workflow.
 *
 * The failed branch carries the sanitized controller output the host activity
 * already collected. A failure summary names what ended the run and nothing
 * about why, so without this the operator's only copy of the reason is a Pod
 * log in a namespace the workflow deletes on its way out.
 */
export type RunControllerResult =
  | {
      readonly exitCode: 0;
      readonly summary: ControllerProgramFinishedSummary;
    }
  | {
      readonly exitCode: 1;
      readonly summary: ControllerFailedRunSummary;
      readonly diagnostic?: string;
    };

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal activity implementations are Promise-native functions consumed directly by proxyActivities. */
/** Activities owned by the worker for one complete run lifecycle. */
export interface RunLifecycleActivities {
  readonly runControllerOnce: (
    input: RunSocietyWorkflowInput,
  ) => Promise<RunControllerResult>;
  readonly cleanupRun: (input: CleanupRunInput) => Promise<void>;
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

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- Temporal workflow entrypoints must use the SDK's own Promise-returning contract. */
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
