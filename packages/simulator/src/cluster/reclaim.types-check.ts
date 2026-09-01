/** @file Type canaries for the closed coarse Temporal lifecycle boundary. */

import type { ControllerFailedRunSummary } from "./controller/summary.js";
import type {
  CleanupRunInput,
  RunControllerResult,
  RunLifecycleActivities,
  runSocietyWorkflow,
  RunSocietyWorkflowInput,
} from "./reclaim.js";

/**
 * The private Temporal boundary carries only its closed serializable lifecycle
 * data, and the coarse workflow preserves the controller's operational result.
 */

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type WorkflowInputKeysAreClosed = Expect<
  Equal<
    keyof RunSocietyWorkflowInput,
    | "runId"
    | "namespace"
    | "controllerImage"
    | "supportImage"
    | "applicationImage"
    | "runtimeCredentials"
    | "experimentModule"
    | "startupTimeoutMs"
    | "cohortSize"
  >
>;
type CleanupInputIsMinimal = Expect<
  Equal<CleanupRunInput, Pick<RunSocietyWorkflowInput, "runId" | "namespace">>
>;
type ControllerActivityInputIsExact = Expect<
  Equal<
    Parameters<RunLifecycleActivities["runControllerOnce"]>,
    [input: RunSocietyWorkflowInput]
  >
>;
type CleanupActivityInputIsExact = Expect<
  Equal<
    Parameters<RunLifecycleActivities["cleanupRun"]>,
    [input: CleanupRunInput]
  >
>;
type WorkflowResultIsOperational = Expect<
  Equal<Awaited<ReturnType<typeof runSocietyWorkflow>>, RunControllerResult>
>;

// A whole-shape equality rather than a key list: with exactOptionalPropertyTypes
// off, `keyof` and an indexed access both read the same for `diagnostic?: string`
// and `diagnostic: string | undefined`, so only this form pins the optionality
// that keeps every existing producer of the failed branch compiling.
type FailedResultIsClosed = Expect<
  Equal<
    Extract<RunControllerResult, { readonly exitCode: 1 }>,
    {
      readonly exitCode: 1;
      readonly summary: ControllerFailedRunSummary;
      readonly diagnostic?: string;
    }
  >
>;

/** Compile-time assertions for the private coarse-workflow boundary. */
export type TemporalWorkflowCanaries = [
  WorkflowInputKeysAreClosed,
  CleanupInputIsMinimal,
  ControllerActivityInputIsExact,
  CleanupActivityInputIsExact,
  WorkflowResultIsOperational,
  FailedResultIsClosed,
];
