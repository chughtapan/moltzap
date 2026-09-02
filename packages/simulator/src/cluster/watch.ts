/** @file Read the controller Job's status and its bounded, redacted output. */

import { Duration, Effect } from "effect";
import { stripVTControlCharacters } from "node:util";
import type {
  ControllerRunResult,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import {
  type KubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
} from "./profile.js";
// safer-arch-ignore no-upward-layer-import: reading the controller Job's logs means parsing exactly the summary the controller printed, so the decoder is owned where the controller writes it.
import {
  CONTROLLER_SUMMARY_PREFIX,
  decodeControllerRunSummary,
} from "./controller/summary.js";
import {
  type JobObservation,
  type KubernetesCallFailed,
  makeKubernetesRunControlApi,
  type RunControlApi,
} from "./kubernetes/calls.js";
import { prepareRun } from "./scaffold.js";

const OBSERVATION_INTERVAL_MS = 1_000;
const FAILED_JOB_DETAIL = "controller Job failed";
/** Characters of sanitized controller output one failure retains. */
const RETAINED_DIAGNOSTIC_CHARACTERS = 4_096;
/** Bytes of controller log fetched, ahead of redaction and that bound. */
const FETCHED_LOG_BYTES = RETAINED_DIAGNOSTIC_CHARACTERS * 2;
const CONTROLLER_LOG_TAIL_LINES = 200;
const SENSITIVE_LOG_LINE =
  /(authorization|bearer|token|secret|password|api[-_ ]?key|agent[-_ ]?key)/iu;

/**
 * Coarse controller state observed by the host-side activity.
 *
 * `completed` is every controller that produced a decodable result, whether or
 * not the run inside it succeeded — the activity returns both the same way.
 */
export type ControllerObservation =
  | { readonly _tag: "running" }
  | {
      readonly _tag: "completed";
      readonly result: ControllerRunResult;
    }
  | {
      readonly _tag: "failed";
      readonly detail: string;
    };

/** Injectable host operations kept outside deterministic workflow code. */
export interface RunLifecycleOperations {
  readonly prepareRun: (
    input: RunSocietyWorkflowInput,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly observeController: (
    input: RunSocietyWorkflowInput,
  ) => Effect.Effect<ControllerObservation, KubernetesCallFailed>;
  readonly deleteRunNamespace: (
    namespace: string,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly runNamespaceExists: (
    namespace: string,
  ) => Effect.Effect<boolean, KubernetesCallFailed>;
  readonly waitBeforeObservation: () => Effect.Effect<void>;
}

/**
 * Remove credentials and terminal controls before retaining controller output.
 * @param value Raw bounded output returned by Kubernetes.
 * @returns Diagnostic text safe to retain in a Temporal failure.
 */
export function sanitizeControllerDiagnostic(value: string): string {
  const normalized = removeUnsafeControlCharacters(
    stripVTControlCharacters(value),
  )
    .split("\n")
    .map((line) =>
      SENSITIVE_LOG_LINE.test(line)
        ? "[redacted credential-bearing log line]"
        : line,
    )
    .join("\n")
    .trim();
  return normalized.slice(-RETAINED_DIAGNOSTIC_CHARACTERS);
}

/**
 * Project Job state and bounded controller output into activity state.
 * @param job Coarse Job status decoded by the Kubernetes adapter.
 * @param logs Optional bounded log tail from the controller container.
 * @returns The coarse state consumed by the activity polling loop.
 */
export function controllerObservation(
  job: JobObservation,
  logs?: string,
): ControllerObservation {
  const resolvedLogs = logs ?? "";
  if (jobSucceeded(job)) {
    return completedControllerObservation(resolvedLogs);
  }
  if (!jobFailed(job)) {
    return { _tag: "running" };
  }
  return failedControllerObservation(job, resolvedLogs);
}

/**
 * Observe the controller Job once, reading its output only when it is terminal.
 *
 * A running Job's log tail is a partial transcript, and the caller polls on the
 * order of a second, so reading it every tick would spend a Pod-log request per
 * observation to produce nothing the observation can use.
 *
 * @param api Kubernetes access held by the worker running this activity.
 * @param input Run identity carrying the namespace to observe.
 * @returns The coarse controller state, with a result once one is decodable.
 * @failure KubernetesCallFailed when the Job's own status cannot be read.
 */
export function observeController(
  api: RunControlApi,
  input: RunSocietyWorkflowInput,
): Effect.Effect<ControllerObservation, KubernetesCallFailed> {
  return Effect.gen(function* () {
    const job = yield* api.readControllerJob(input.namespace);
    const logs =
      jobSucceeded(job) || jobFailed(job)
        ? yield* terminalControllerLogs(api, input.namespace)
        : undefined;
    return controllerObservation(job, logs);
  }).pipe(Effect.withSpan("observeController"));
}

/**
 * Build the live Kubernetes operations used by one activity worker.
 * @param profile Private local or GKE cluster selected by the host.
 * @returns Operations backed by the worker Pod's service account.
 */
export function makeKubernetesRunLifecycleOperations(
  profile: KubernetesExecutionProfile = LOCAL_KUBERNETES_EXECUTION_PROFILE,
): RunLifecycleOperations {
  return runLifecycleOperations(makeKubernetesRunControlApi(), profile);
}

// The Job's own status already says whether the run ended and how, so output
// that cannot be read costs detail in the failure message and nothing else. A
// terminal Job whose Pod was evicted before its log could be fetched still has
// to produce an observation rather than fail the whole activity attempt.
function terminalControllerLogs(
  api: RunControlApi,
  namespace: string,
): Effect.Effect<string | undefined> {
  return api
    .readControllerLogs(namespace, CONTROLLER_LOG_TAIL_LINES, FETCHED_LOG_BYTES)
    .pipe(
      Effect.catchAll((failure) =>
        Effect.logWarning(
          `Simulator controller logs unavailable: ${failure.message}`,
        ).pipe(Effect.as(undefined)),
      ),
    );
}

/**
 * Bind one run's lifecycle to a cluster the worker Pod already has access to.
 * @param api Kubernetes access held by the worker running these activities.
 * @param profile Private local or GKE cluster selected by the host.
 * @returns The lifecycle operations the worker's activities are built from.
 */
function runLifecycleOperations(
  api: RunControlApi,
  profile: KubernetesExecutionProfile,
): RunLifecycleOperations {
  return Object.freeze({
    prepareRun: (input: RunSocietyWorkflowInput) =>
      prepareRun(api, input, profile),
    observeController: (input: RunSocietyWorkflowInput) =>
      observeController(api, input),
    deleteRunNamespace: (namespace: string) =>
      api.deleteRunNamespace(namespace),
    runNamespaceExists: (namespace: string) =>
      api.runNamespaceExists(namespace),
    waitBeforeObservation: () =>
      Effect.sleep(Duration.millis(OBSERVATION_INTERVAL_MS)),
  });
}

function removeUnsafeControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    if (safeDiagnosticCodePoint(character.codePointAt(0))) {
      result += character;
    }
  }
  return result;
}

function safeDiagnosticCodePoint(code?: number): boolean {
  if (code === undefined) {
    return false;
  }
  if (code === 9 || code === 10 || code === 13) {
    return true;
  }
  return code >= 32 && code !== 127;
}

function jobSucceeded(job: JobObservation): boolean {
  return job.succeeded > 0 || jobConditionIsTrue(job, "Complete");
}

function jobFailed(job: JobObservation): boolean {
  return (
    jobConditionIsTrue(job, "Failed") || (job.failed > 0 && job.active === 0)
  );
}

function jobConditionIsTrue(job: JobObservation, type: string): boolean {
  return job.conditions.some(
    (condition) => condition.type === type && condition.status === "True",
  );
}

function completedControllerObservation(logs: string): ControllerObservation {
  const summary = controllerSummary(logs);
  if (summary === undefined || summary._tag !== "ProgramFinished") {
    return {
      _tag: "failed",
      detail: "controller Job completed without a valid result summary",
    };
  }
  return {
    _tag: "completed",
    result: { exitCode: 0, summary },
  };
}

// The activity returns a failed run rather than failing, so the reason the Job
// gave has to ride the result or it is gone with the namespace.
function failedControllerObservation(
  job: JobObservation,
  logs: string,
): ControllerObservation {
  const result = failedControllerResult(logs);
  const detail = failureDetail(job, logs);
  return result === undefined
    ? { _tag: "failed", detail }
    : { _tag: "completed", result: { ...result, diagnostic: detail } };
}

type FailedControllerResult = Extract<
  ControllerRunResult,
  { readonly exitCode: 1 }
>;

function failedControllerResult(
  logs: string,
): FailedControllerResult | undefined {
  const summary = controllerSummary(logs);
  if (summary === undefined || summary._tag === "ProgramFinished") {
    return undefined;
  }
  return { exitCode: 1, summary };
}

// Sanitized once, over the whole composition rather than each part: bounding
// the pieces separately lets their concatenation exceed the bound, and the
// caller then trims the front — which is where the Job condition's reason is.
function failureDetail(job: JobObservation, logs: string): string {
  return sanitizeControllerDiagnostic(
    [FAILED_JOB_DETAIL, conditionDetail(job), controllerLogs(logs)]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n"),
  );
}

function conditionDetail(job: JobObservation): string | undefined {
  const failed = job.conditions.find(
    (condition) => condition.type === "Failed" && condition.status === "True",
  );
  if (failed === undefined) {
    return undefined;
  }
  const detail = [failed.reason, failed.message].filter(Boolean).join(": ");
  return detail.length === 0 ? undefined : detail;
}

function controllerLogs(logs: string): string {
  return logs
    .split("\n")
    .filter((line) => !line.startsWith(CONTROLLER_SUMMARY_PREFIX))
    .join("\n");
}

function controllerSummary(logs: string) {
  return decodeControllerRunSummary(logs);
}
