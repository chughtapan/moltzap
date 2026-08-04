/** @file Kubernetes client operations owned by the Temporal activity. */

import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  RbacAuthorizationV1Api,
  type V1Job,
} from "@kubernetes/client-node";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
  ControllerObservation,
  RunLifecycleOperations,
} from "./activities.js";
import type {
  RunControllerResult,
  RunSocietyWorkflowInput,
} from "./contract.js";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "../kubernetes/profile.js";
import {
  CONTROLLER_SUMMARY_PREFIX,
  decodeControllerRunSummary,
} from "../controller/summary.js";
import {
  CONTROLLER_NAME,
  ownedRunControlManifests,
  runNamespaceManifest,
  runOwnerManifest,
  type OwnedRunControlManifests,
} from "./manifests.js";

const KUEUE_GROUP = "kueue.x-k8s.io";
const KUEUE_VERSION = "v1beta2";
const LOCAL_QUEUES = "localqueues";
const FIELD_MANAGER = "moltzap-simulator";
const OBSERVATION_INTERVAL_MS = 1_000;
const DIAGNOSTIC_LIMIT = 4_096;
const CONTROLLER_LOG_TAIL_LINES = 200;
const SENSITIVE_LOG_LINE =
  /(authorization|bearer|token|secret|password|api[-_ ]?key|agent[-_ ]?key)/iu;

interface KubernetesClients {
  readonly batch: BatchV1Api;
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
  readonly rbac: RbacAuthorizationV1Api;
}

class KubernetesRunControlFailed extends Error {
  override readonly name = "KubernetesRunControlFailed";

  constructor(operation: string, cause: unknown) {
    const status =
      cause instanceof ApiException
        ? ` (Kubernetes ${String(cause.code)})`
        : "";
    super(`${operation} failed${status}`);
  }
}

function isAbsent(cause: unknown): boolean {
  return cause instanceof ApiException && cause.code === 404;
}

function safeKubernetesStatus(cause: unknown): string {
  return cause instanceof ApiException
    ? ` (Kubernetes ${String(cause.code)})`
    : "";
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Kubernetes and Temporal expose native Promise boundaries. */

async function request<Result>(
  operation: string,
  evaluate: () => Promise<Result>,
): Promise<Result> {
  try {
    return await evaluate();
  } catch (cause) {
    throw new KubernetesRunControlFailed(operation, cause);
  }
}

async function ignoreAbsent(
  operation: string,
  evaluate: () => Promise<unknown>,
): Promise<void> {
  try {
    await evaluate();
  } catch (cause) {
    if (!isAbsent(cause)) {
      throw new KubernetesRunControlFailed(operation, cause);
    }
  }
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

function conditionDetail(job: V1Job): string | undefined {
  const failed = job.status?.conditions?.find(
    (condition) => condition.type === "Failed" && condition.status === "True",
  );
  if (failed === undefined) {
    return undefined;
  }
  const detail = [failed.reason, failed.message].filter(Boolean).join(": ");
  return detail.length === 0 ? undefined : sanitizeControllerDiagnostic(detail);
}

function jobSucceeded(job: V1Job): boolean {
  return (
    (job.status?.succeeded ?? 0) > 0 ||
    (job.status?.conditions?.some(
      (condition) =>
        condition.type === "Complete" && condition.status === "True",
    ) ??
      false)
  );
}

function jobConditionIsTrue(job: V1Job, type: string): boolean {
  return (
    job.status?.conditions?.some(
      (condition) => condition.type === type && condition.status === "True",
    ) === true
  );
}

function jobFailed(job: V1Job): boolean {
  if (jobConditionIsTrue(job, "Failed")) {
    return true;
  }
  const failed = job.status?.failed ?? 0;
  const active = job.status?.active ?? 0;
  return failed > 0 && active === 0;
}

function controllerSummary(logs: string) {
  return decodeControllerRunSummary(logs);
}

function succeededControllerObservation(logs: string): ControllerObservation {
  const summary = controllerSummary(logs);
  if (summary === undefined || summary._tag !== "ProgramFinished") {
    return {
      _tag: "failed",
      detail: "controller Job completed without a valid result summary",
    };
  }
  return {
    _tag: "succeeded",
    result: { exitCode: 0, summary },
  };
}

function failedControllerResult(logs: string): RunControllerResult | undefined {
  const summary = controllerSummary(logs);
  if (summary === undefined || summary._tag === "ProgramFinished") {
    return undefined;
  }
  return { exitCode: 1, summary };
}

function sanitizedControllerLogs(logs: string): string {
  return sanitizeControllerDiagnostic(
    logs
      .split("\n")
      .filter((line) => !line.startsWith(CONTROLLER_SUMMARY_PREFIX))
      .join("\n"),
  );
}

function failedControllerObservation(
  job: V1Job,
  logs: string,
): ControllerObservation {
  const result = failedControllerResult(logs);
  const detail = [
    "controller Job failed",
    conditionDetail(job),
    sanitizedControllerLogs(logs),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
  return result === undefined
    ? { _tag: "failed", detail }
    : { _tag: "failed", detail, result };
}

/**
 * Project generated Job state and bounded controller output into activity state.
 * @param job Generated Job status returned by Kubernetes.
 * @param logs Optional bounded log tail from the controller container.
 * @returns The coarse state consumed by the activity polling loop.
 */
export function controllerObservation(
  job: V1Job,
  logs?: string,
): ControllerObservation {
  const resolvedLogs = logs ?? "";
  if (jobSucceeded(job)) {
    return succeededControllerObservation(resolvedLogs);
  }
  if (!jobFailed(job)) {
    return { _tag: "running" };
  }
  return failedControllerObservation(job, resolvedLogs);
}

async function controllerLogs(
  clients: KubernetesClients,
  namespace: string,
): Promise<string | undefined> {
  try {
    const pods = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${CONTROLLER_NAME}`,
    });
    const podName = pods.items.find(
      (pod) => pod.metadata?.deletionTimestamp === undefined,
    )?.metadata?.name;
    if (podName === undefined) {
      return undefined;
    }
    const output = await clients.core.readNamespacedPodLog({
      namespace,
      name: podName,
      container: CONTROLLER_NAME,
      tailLines: CONTROLLER_LOG_TAIL_LINES,
      limitBytes: DIAGNOSTIC_LIMIT * 2,
    });
    return output.length === 0 ? undefined : output;
  } catch (cause) {
    console.warn(
      `Simulator controller logs unavailable${safeKubernetesStatus(cause)}`,
    );
    return undefined;
  }
}

async function createRunRoot(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
): Promise<string> {
  await request("create run namespace", () =>
    clients.core.createNamespace({
      body: runNamespaceManifest(input),
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  const root = await request("create run owner", () =>
    clients.core.createNamespacedConfigMap({
      namespace: input.namespace,
      body: runOwnerManifest(input),
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  const ownerUid = root.metadata?.uid;
  if (ownerUid === undefined || ownerUid.length === 0) {
    throw new KubernetesRunControlFailed("read run owner UID", undefined);
  }
  return ownerUid;
}

async function createExperimentAndQueue(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
  manifests: OwnedRunControlManifests,
): Promise<void> {
  await request("create experiment module", () =>
    clients.core.createNamespacedConfigMap({
      namespace: input.namespace,
      body: manifests.experiment,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  await request("create run queue", () =>
    clients.custom.createNamespacedCustomObject({
      group: KUEUE_GROUP,
      version: KUEUE_VERSION,
      namespace: input.namespace,
      plural: LOCAL_QUEUES,
      body: manifests.localQueue,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
}

async function createControllerAccess(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
  manifests: OwnedRunControlManifests,
): Promise<void> {
  await request("create controller service account", () =>
    clients.core.createNamespacedServiceAccount({
      namespace: input.namespace,
      body: manifests.serviceAccount,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  await request("create controller role", () =>
    clients.rbac.createNamespacedRole({
      namespace: input.namespace,
      body: manifests.role,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  await request("create controller role binding", () =>
    clients.rbac.createNamespacedRoleBinding({
      namespace: input.namespace,
      body: manifests.roleBinding,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
}

async function createControllerEndpoint(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
  manifests: OwnedRunControlManifests,
): Promise<void> {
  await request("create router service", () =>
    clients.core.createNamespacedService({
      namespace: input.namespace,
      body: manifests.routerService,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
  await request("create controller job", () =>
    clients.batch.createNamespacedJob({
      namespace: input.namespace,
      body: manifests.controllerJob,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
    }),
  );
}

async function prepareRun(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
  profile: KubernetesExecutionProfile,
): Promise<void> {
  const ownerUid = await createRunRoot(clients, input);
  const manifests = ownedRunControlManifests(input, ownerUid, profile);
  await createExperimentAndQueue(clients, input, manifests);
  await createControllerAccess(clients, input, manifests);
  await createControllerEndpoint(clients, input, manifests);
}

async function observeController(
  clients: KubernetesClients,
  input: RunSocietyWorkflowInput,
): Promise<ControllerObservation> {
  const job = await request("observe controller job", () =>
    clients.batch.readNamespacedJob({
      namespace: input.namespace,
      name: CONTROLLER_NAME,
    }),
  );
  const logs =
    jobSucceeded(job) || jobFailed(job)
      ? await controllerLogs(clients, input.namespace)
      : undefined;
  return controllerObservation(job, logs);
}

function makeClients(profile: KubernetesExecutionProfile): KubernetesClients {
  const config = new KubeConfig();
  config.loadFromDefault();
  if (profile.kind === "gke") {
    if (config.getContextObject(profile.kubeContext) === null) {
      throw new KubernetesRunControlFailed(
        "select configured kubeconfig context",
        undefined,
      );
    }
    config.setCurrentContext(profile.kubeContext);
  }
  return {
    batch: config.makeApiClient(BatchV1Api),
    core: config.makeApiClient(CoreV1Api),
    custom: config.makeApiClient(CustomObjectsApi),
    rbac: config.makeApiClient(RbacAuthorizationV1Api),
  };
}

/**
 * Build the live Kubernetes operations used by one activity worker.
 * @param profile Private local or GKE infrastructure selected by the host.
 * @returns Operations backed by the host's selected kubeconfig context.
 */
export function makeKubernetesRunLifecycleOperations(
  profile: KubernetesExecutionProfile = LOCAL_KUBERNETES_EXECUTION_PROFILE,
): RunLifecycleOperations {
  const clients = makeClients(profile);
  return Object.freeze({
    prepareRun: (input: RunSocietyWorkflowInput) =>
      prepareRun(clients, input, profile),
    observeController: (input: RunSocietyWorkflowInput) =>
      observeController(clients, input),
    deleteRunNamespace: (namespace: string) =>
      ignoreAbsent("delete run namespace", () =>
        clients.core.deleteNamespace({
          name: namespace,
          propagationPolicy: "Foreground",
        }),
      ),
    runNamespaceExists: async (namespace: string) => {
      try {
        await clients.core.readNamespace({ name: namespace });
        return true;
      } catch (cause) {
        if (isAbsent(cause)) {
          return false;
        }
        throw new KubernetesRunControlFailed(
          "observe run namespace deletion",
          cause,
        );
      }
    },
    waitBeforeObservation: () => delay(OBSERVATION_INTERVAL_MS),
  });
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Kubernetes and Temporal boundaries. */
