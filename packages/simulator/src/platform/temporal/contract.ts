/** @file Serializable contract for the coarse run-lifecycle workflow. */

import type {
  ControllerFailedRunSummary,
  ControllerProgramFinishedSummary,
} from "../controller/summary.js";

/** Private data needed to start one in-cluster experiment controller. */
export interface RunSocietyWorkflowInput {
  readonly runId: string;
  readonly namespace: string;
  readonly controllerImage: string;
  readonly supportImage: string;
  /** Provider credentials retained only for the transient controller Job. */
  readonly runtimeCredentials?: Readonly<
    Partial<Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string>>
  >;
  /** Complete `.mjs` source mounted into the controller Job. */
  readonly experimentModule: string;
}

/** Identity sufficient for idempotent deletion of one run's resources. */
export type CleanupRunInput = Readonly<
  Pick<RunSocietyWorkflowInput, "runId" | "namespace">
>;

/** Closed controller process result retained by the coarse workflow. */
export type RunControllerResult =
  | {
      readonly exitCode: 0;
      readonly summary: ControllerProgramFinishedSummary;
    }
  | {
      readonly exitCode: 1;
      readonly summary: ControllerFailedRunSummary;
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
