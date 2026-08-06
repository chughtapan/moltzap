/** @file Read the controller Job's status and its bounded, redacted output. */

import { stripVTControlCharacters } from "node:util";
import { Duration, Effect } from "effect";
import type {
  ControllerObservation,
  RunLifecycleOperations,
} from "./temporal.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./reclaim.js";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "./profile.js";
// safer-arch-ignore no-upward-layer-import: reading the controller Job's logs means parsing exactly the summary the controller printed, so the decoder is owned where the controller writes it.
import {
  CONTROLLER_SUMMARY_PREFIX,
  decodeControllerRunSummary,
} from "./controller/summary.js";
import {
  makeKubernetesRunControlApi,
  type JobObservation,
  type KubernetesCallFailed,
  type RunControlApi,
} from "./kubernetes/calls.js";
import { prepareRun } from "./scaffold.js";

const OBSERVATION_INTERVAL_MS = 1_000;
const FAILED_JOB_DETAIL = "controller Job failed";
const DIAGNOSTIC_LIMIT = 4_096;
const CONTROLLER_LOG_TAIL_LINES = 200;
const SENSITIVE_LOG_LINE =
  /(authorization|bearer|token|secret|password|api[-_ ]?key|agent[-_ ]?key)/iu;

function safeDiagnosticCodePoint(code?: number): boolean {
  if (code === undefined) {
    return false;
  }
  if (code === 9 || code === 10 || code === 13) {
    return true;
  }
  return code >= 32 && code !== 127;
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
  return normalized.slice(-DIAGNOSTIC_LIMIT);
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

function jobConditionIsTrue(job: JobObservation, type: string): boolean {
  return job.conditions.some(
    (condition) => condition.type === type && condition.status === "True",
  );
}

function jobSucceeded(job: JobObservation): boolean {
  return job.succeeded > 0 || jobConditionIsTrue(job, "Complete");
}

function jobFailed(job: JobObservation): boolean {
  return (
    jobConditionIsTrue(job, "Failed") || (job.failed > 0 && job.active === 0)
  );
}

function controllerSummary(logs: string) {
  return decodeControllerRunSummary(logs);
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

type FailedControllerResult = Extract<
  RunControllerResult,
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

function controllerLogs(logs: string): string {
  return logs
    .split("\n")
    .filter((line) => !line.startsWith(CONTROLLER_SUMMARY_PREFIX))
    .join("\n");
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

// A run that failed with a decodable summary is a completed observation, not a
// failed one: the activity returns it rather than failing, so the reason the
// Job gave has to ride the result or it is gone with the namespace.
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

// The Job's own status already says whether the run ended and how, so output
// that cannot be read costs detail in the failure message and nothing else. A
// terminal Job whose Pod was evicted before its log could be fetched still has
// to produce an observation rather than fail the whole activity attempt.
function terminalControllerLogs(
  api: RunControlApi,
  namespace: string,
): Effect.Effect<string | undefined> {
  return api
    .readControllerLogs(
      namespace,
      CONTROLLER_LOG_TAIL_LINES,
      DIAGNOSTIC_LIMIT * 2,
    )
    .pipe(
      Effect.catchAll((failure) =>
        Effect.logWarning(
          `Simulator controller logs unavailable: ${failure.message}`,
        ).pipe(Effect.as(undefined)),
      ),
    );
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
