/**
 * The private Temporal boundary carries only its closed serializable lifecycle
 * data, and the coarse workflow preserves the controller's operational result.
 */

import type {
  CleanupRunInput,
  RunControllerResult,
  RunLifecycleActivities,
  RunSocietyWorkflowInput,
  runSocietyWorkflow,
} from "./reclaim.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;

type WorkflowInputKeysAreClosed = Expect<
  Equal<
    keyof RunSocietyWorkflowInput,
    | "runId"
    | "namespace"
    | "controllerImage"
    | "supportImage"
    | "runtimeCredentials"
    | "experimentModule"
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

/** Compile-time assertions for the private coarse-workflow boundary. */
export type TemporalWorkflowCanaries = [
  WorkflowInputKeysAreClosed,
  CleanupInputIsMinimal,
  ControllerActivityInputIsExact,
  CleanupActivityInputIsExact,
  WorkflowResultIsOperational,
];
