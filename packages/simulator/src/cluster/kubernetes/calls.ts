/**
 * @file Every Kubernetes API call the simulator makes: the run-scoped society
 * operations the controller drives, the run-lifecycle operations the worker
 * drives, and the control-plane installation the host drives.
 */

import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  RbacAuthorizationV1Api,
  type V1Job,
  type V1JobCondition,
  type V1ObjectMeta,
} from "@kubernetes/client-node";
import { Duration, Effect, Schema } from "effect";
import { ClusterError } from "../cluster.js";
import type { KubernetesExecutionProfile } from "../profile.js";
import type { RunSocietyWorkflowInput } from "../reclaim.js";
import {
  CONTROLLER_NAME,
  runNamespaceManifest,
  runOwnerManifest,
  RUN_WORKER_NAME,
  runWorkerManifests,
  SYSTEM_NAMESPACE,
  type OwnedRunControlManifests,
  type RunWorkerManifests,
  type RunWorkerOptions,
} from "./objects.js";

const BRIDGE_PROBE_TIMEOUT = Duration.seconds(2);

/** Field ownership and strict validation applied to every write. */
const APPLIED = Object.freeze({
  fieldManager: "moltzap-simulator",
  fieldValidation: "Strict",
} as const);

const KUEUE_GROUP = "kueue.x-k8s.io";
const KUEUE_VERSION = "v1beta2";
const KUEUE_WORKLOADS = "workloads";
const LOCAL_QUEUES = "localqueues";
const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOXES = "sandboxes";

const condition = Schema.Struct({
  type: Schema.String,
  status: Schema.String,
  observedGeneration: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const objectMetadata = Schema.Struct({
  name: Schema.String,
  generation: Schema.optional(Schema.Number),
  deletionTimestamp: Schema.optional(Schema.String),
});

const workloadObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      conditions: Schema.optional(Schema.Array(condition)),
      admission: Schema.optional(
        Schema.Struct({
          clusterQueue: Schema.String,
          podSetAssignments: Schema.optional(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                flavors: Schema.optional(
                  Schema.Record({ key: Schema.String, value: Schema.String }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});

const sandboxObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      conditions: Schema.optional(Schema.Array(condition)),
      serviceFQDN: Schema.optional(Schema.String),
      selector: Schema.optional(Schema.String),
      podIPs: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const terminatedContainer = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const podObservation = Schema.Struct({
  metadata: objectMetadata,
  status: Schema.optional(
    Schema.Struct({
      phase: Schema.optional(Schema.String),
      containerStatuses: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            restartCount: Schema.Number,
            state: Schema.Struct({
              terminated: Schema.optional(terminatedContainer),
            }),
          }),
        ),
      ),
    }),
  ),
});

const podListObservation = Schema.Struct({
  items: Schema.Array(podObservation),
});

/** Minimal condition retained from a Kueue or Agent Sandbox status. */
type KubernetesCondition = typeof condition.Type;

/** Kueue state consumed by aggregate admission and loss checks. */
export type WorkloadObservation = typeof workloadObservation.Type;

/** Agent Sandbox state consumed by readiness and backing-Pod discovery. */
export type SandboxObservation = typeof sandboxObservation.Type;

/** Backing-Pod state consumed by runtime termination observation. */
export type PodObservation = typeof podObservation.Type;

/** Private manifest shape submitted through the custom-object API. */
export type KubernetesManifest = Readonly<Record<string, unknown>>;

/** Exact cluster calls needed to bring up and observe one society. */
export interface KubernetesSocietyApi {
  readonly createWorkload: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, ClusterError>;
  readonly readWorkload: (
    name: string,
  ) => Effect.Effect<WorkloadObservation, ClusterError>;
  readonly deleteWorkload: (name: string) => Effect.Effect<void, ClusterError>;
  readonly createSecret: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, ClusterError>;
  readonly deleteSecret: (name: string) => Effect.Effect<void, ClusterError>;
  readonly createSandbox: (
    manifest: KubernetesManifest,
  ) => Effect.Effect<void, ClusterError>;
  readonly readSandbox: (
    name: string,
  ) => Effect.Effect<SandboxObservation, ClusterError>;
  readonly deleteSandbox: (name: string) => Effect.Effect<void, ClusterError>;
  readonly listPods: (
    selector: string,
  ) => Effect.Effect<readonly PodObservation[], ClusterError>;
  /**
   * Whether an application's controller bridge port accepts a connection.
   * Refusal is an ordinary not-yet-ready observation, never a cluster failure,
   * so this reports a verdict instead of an error.
   */
  readonly bridgeAccepts: (
    host: string,
    port: number,
  ) => Effect.Effect<boolean>;
}

function clusterError(operation: string, cause: unknown): ClusterError {
  return new ClusterError({
    detail: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

function request<A>(operation: string, evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => clusterError(operation, cause),
  });
}

function decode<A, I, R>(
  operation: string,
  schema: Schema.Schema<A, I, R>,
  value: unknown,
): Effect.Effect<A, ClusterError, R> {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) => clusterError(operation, cause)),
  );
}

function ignoreAbsent(
  operation: string,
  evaluate: () => PromiseLike<unknown>,
): Effect.Effect<void, ClusterError> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ApiException && cause.code === 404
        ? undefined
        : clusterError(operation, cause),
  }).pipe(
    Effect.catchAll((failure) =>
      failure === undefined ? Effect.void : Effect.fail(failure),
    ),
    Effect.asVoid,
  );
}

function decodeWorkload(value: unknown) {
  return decode(
    "decode aggregate capacity reservation",
    workloadObservation,
    value,
  );
}

function workloadOperations(
  namespace: string,
  custom: CustomObjectsApi,
): Pick<
  KubernetesSocietyApi,
  "createWorkload" | "readWorkload" | "deleteWorkload"
> {
  return {
    createWorkload: (body) =>
      request("create aggregate capacity reservation", () =>
        custom.createNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          body,
          ...APPLIED,
        }),
      ).pipe(Effect.asVoid),
    readWorkload: (name) =>
      request("observe aggregate capacity reservation", () =>
        custom.getNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          name,
        }),
      ).pipe(Effect.flatMap(decodeWorkload)),
    deleteWorkload: (name) =>
      ignoreAbsent("delete aggregate capacity reservation", () =>
        custom.deleteNamespacedCustomObject({
          group: KUEUE_GROUP,
          version: KUEUE_VERSION,
          namespace,
          plural: KUEUE_WORKLOADS,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
  };
}

function coreOperations(
  namespace: string,
  core: CoreV1Api,
): Pick<KubernetesSocietyApi, "createSecret" | "deleteSecret" | "listPods"> {
  return {
    createSecret: (body) =>
      request("create runtime bootstrap", () =>
        core.createNamespacedSecret({
          namespace,
          body,
          ...APPLIED,
        }),
      ).pipe(Effect.asVoid),
    deleteSecret: (name) =>
      ignoreAbsent("delete runtime bootstrap", () =>
        core.deleteNamespacedSecret({
          namespace,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
    listPods: (selector) =>
      request("observe sandbox application", () =>
        core.listNamespacedPod({ namespace, labelSelector: selector }),
      ).pipe(
        Effect.flatMap((value) =>
          decode("decode sandbox application", podListObservation, value),
        ),
        Effect.map((value) => value.items),
      ),
  };
}

/**
 * Open and immediately drop one TCP connection to a controller bridge port.
 * The probe sends and reads nothing, so a runtime that prints no startup
 * banner is still observed as ready the moment it can serve its controller.
 * @param host In-cluster address of the Sandbox service.
 * @param port Controller bridge port declared by the rendered application.
 * @returns Whether the port accepted a connection before the probe deadline.
 */
function bridgeAccepts(host: string, port: number): Effect.Effect<boolean> {
  return Effect.async<boolean>((resume) => {
    const socket = connect({ host, port });
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resume(Effect.succeed(accepted));
    };
    socket.setTimeout(Duration.toMillis(BRIDGE_PROBE_TIMEOUT), () => {
      settle(false);
    });
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
    return Effect.sync(() => {
      settled = true;
      socket.destroy();
    });
  });
}

function sandboxOperations(
  namespace: string,
  custom: CustomObjectsApi,
): Pick<
  KubernetesSocietyApi,
  "createSandbox" | "readSandbox" | "deleteSandbox"
> {
  return {
    createSandbox: (body) =>
      request("create agent sandbox", () =>
        custom.createNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          body,
          ...APPLIED,
        }),
      ).pipe(Effect.asVoid),
    readSandbox: (name) =>
      request("observe agent sandbox", () =>
        custom.getNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          name,
        }),
      ).pipe(
        Effect.flatMap((value) =>
          decode("decode agent sandbox", sandboxObservation, value),
        ),
      ),
    deleteSandbox: (name) =>
      ignoreAbsent("delete agent sandbox", () =>
        custom.deleteNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace,
          plural: SANDBOXES,
          name,
          propagationPolicy: "Foreground",
        }),
      ),
  };
}

/**
 * Build the live in-cluster client without leaking generated API types.
 * @param namespace Namespace that owns the run-scoped resources.
 * @returns Narrow Kubernetes operations consumed by the cluster.
 */
export function makeInClusterKubernetesSocietyApi(
  namespace: string,
): KubernetesSocietyApi {
  const config = new KubeConfig();
  config.loadFromDefault();
  const custom = config.makeApiClient(CustomObjectsApi);
  const core = config.makeApiClient(CoreV1Api);
  return Object.freeze({
    ...workloadOperations(namespace, custom),
    ...coreOperations(namespace, core),
    ...sandboxOperations(namespace, custom),
    bridgeAccepts,
  });
}

interface ConditionedObservation {
  readonly metadata: { readonly generation?: number };
  readonly status?: { readonly conditions?: readonly KubernetesCondition[] };
}

/**
 * Test whether an object has a positive current-generation condition.
 * @param observation Narrow object status returned by the live decoder.
 * @param type Kubernetes condition type to find.
 * @returns Whether the current generation reports that condition as true.
 */
export function currentConditionIsTrue(
  observation: ConditionedObservation,
  type: string,
): boolean {
  const generation = observation.metadata.generation;
  return (
    observation.status?.conditions?.some(
      (entry) =>
        entry.type === type &&
        entry.status === "True" &&
        (generation === undefined || entry.observedGeneration === generation),
    ) ?? false
  );
}

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The Temporal activity and host submission paths reach Kubernetes through the generated client's native Promise API. */

/** Coarse controller Job status, total so its readers need no defaulting. */
export interface JobObservation {
  readonly succeeded: number;
  readonly failed: number;
  readonly active: number;
  readonly conditions: readonly JobCondition[];
}

/** One Job condition retained from the generated status. */
export interface JobCondition {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
}

/** Rollout state the installer compares against its own availability rule. */
export interface WorkerAvailability {
  readonly generation: number;
  readonly observedGeneration: number;
  readonly availableReplicas: number;
}

/** One installable member of the cluster's run-worker control plane. */
export type RunWorkerObject = keyof RunWorkerManifests;

/** Kubernetes access the Temporal activity needs for one run's lifetime. */
export interface RunControlApi {
  /** Create the run's Namespace and immutable owner; yields the owner UID. */
  readonly createRunRoot: (input: RunSocietyWorkflowInput) => Promise<string>;
  readonly createExperimentAndQueue: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Promise<void>;
  readonly createControllerAccess: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Promise<void>;
  readonly createRouterService: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Promise<void>;
  readonly startController: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Promise<void>;
  readonly readControllerJob: (namespace: string) => Promise<JobObservation>;
  /** Bounded controller output, or nothing when the Pod cannot be read. */
  readonly readControllerLogs: (
    namespace: string,
    tailLines: number,
    limitBytes: number,
  ) => Promise<string | undefined>;
  readonly deleteRunNamespace: (namespace: string) => Promise<void>;
  readonly runNamespaceExists: (namespace: string) => Promise<boolean>;
}

/** Kubernetes access the host needs to install the cluster's run worker. */
export interface RunWorkerInstallApi {
  /**
   * Create one control-plane object, or replace the revision already installed.
   *
   * The worker outlives every submission, so each install meets an object that
   * is either absent or a previous revision of itself. Replacing at the
   * observed resourceVersion makes a concurrent submitter's write a visible
   * conflict rather than a silent overwrite.
   */
  readonly install: (object: RunWorkerObject) => Promise<void>;
  readonly readWorkerAvailability: () => Promise<WorkerAvailability>;
  /** Sleep between rollout observations while the worker starts. */
  readonly wait: (milliseconds: number) => Promise<void>;
}

/** Failure of one Kubernetes call, carrying the status but never the body. */
class KubernetesCallFailed extends Error {
  override readonly name = "KubernetesCallFailed";

  constructor(operation: string, cause?: unknown) {
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

async function attempt<Result>(
  operation: string,
  evaluate: () => Promise<Result>,
): Promise<Result> {
  try {
    return await evaluate();
  } catch (cause) {
    throw new KubernetesCallFailed(operation, cause);
  }
}

async function attemptUnlessAbsent(
  operation: string,
  evaluate: () => Promise<unknown>,
): Promise<void> {
  try {
    await evaluate();
  } catch (cause) {
    if (!isAbsent(cause)) {
      throw new KubernetesCallFailed(operation, cause);
    }
  }
}

interface RunControlClients {
  readonly batch: BatchV1Api;
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
  readonly rbac: RbacAuthorizationV1Api;
}

function jobCondition(condition: V1JobCondition): JobCondition {
  return {
    type: condition.type,
    status: condition.status,
    ...(condition.reason === undefined ? {} : { reason: condition.reason }),
    ...(condition.message === undefined ? {} : { message: condition.message }),
  };
}

function jobObservation(job: V1Job): JobObservation {
  const status = job.status ?? {};
  return {
    succeeded: status.succeeded ?? 0,
    failed: status.failed ?? 0,
    active: status.active ?? 0,
    conditions: (status.conditions ?? []).map(jobCondition),
  };
}

async function createRunRoot(
  clients: RunControlClients,
  input: RunSocietyWorkflowInput,
): Promise<string> {
  await attempt("create run namespace", () =>
    clients.core.createNamespace({
      body: runNamespaceManifest(input),
      ...APPLIED,
    }),
  );
  const root = await attempt("create run owner", () =>
    clients.core.createNamespacedConfigMap({
      namespace: input.namespace,
      body: runOwnerManifest(input),
      ...APPLIED,
    }),
  );
  const ownerUid = root.metadata?.uid;
  if (ownerUid === undefined || ownerUid.length === 0) {
    throw new KubernetesCallFailed("read run owner UID");
  }
  return ownerUid;
}

// A Pod already being deleted is skipped: its log stream ends wherever the
// eviction cut it, which would read as a controller that stopped on its own.
async function readControllerLogs(
  clients: RunControlClients,
  namespace: string,
  tailLines: number,
  limitBytes: number,
): Promise<string | undefined> {
  const pods = await attempt("observe controller pod", () =>
    clients.core.listNamespacedPod({
      namespace,
      labelSelector: `job-name=${CONTROLLER_NAME}`,
    }),
  );
  const podName = pods.items.find(
    (pod) => pod.metadata?.deletionTimestamp === undefined,
  )?.metadata?.name;
  if (podName === undefined) {
    return undefined;
  }
  const output = await attempt("read controller log", () =>
    clients.core.readNamespacedPodLog({
      namespace,
      name: podName,
      container: CONTROLLER_NAME,
      tailLines,
      limitBytes,
    }),
  );
  return output.length === 0 ? undefined : output;
}

// These operations run inside the cluster they act on, so the API credentials
// come from the worker Pod's service account. The profile's kubeconfig context
// names how a host reaches the cluster and has no meaning here.
function runControlClients(): RunControlClients {
  const config = new KubeConfig();
  config.loadFromDefault();
  return {
    batch: config.makeApiClient(BatchV1Api),
    core: config.makeApiClient(CoreV1Api),
    custom: config.makeApiClient(CustomObjectsApi),
    rbac: config.makeApiClient(RbacAuthorizationV1Api),
  };
}

async function createExperimentAndQueue(
  clients: RunControlClients,
  namespace: string,
  manifests: OwnedRunControlManifests,
): Promise<void> {
  await attempt("create experiment module", () =>
    clients.core.createNamespacedConfigMap({
      namespace,
      body: manifests.experiment,
      ...APPLIED,
    }),
  );
  await attempt("create run queue", () =>
    clients.custom.createNamespacedCustomObject({
      group: KUEUE_GROUP,
      version: KUEUE_VERSION,
      namespace,
      plural: LOCAL_QUEUES,
      body: manifests.localQueue,
      ...APPLIED,
    }),
  );
}

async function createControllerAccess(
  clients: RunControlClients,
  namespace: string,
  manifests: OwnedRunControlManifests,
): Promise<void> {
  await attempt("create controller service account", () =>
    clients.core.createNamespacedServiceAccount({
      namespace,
      body: manifests.serviceAccount,
      ...APPLIED,
    }),
  );
  await attempt("create controller role", () =>
    clients.rbac.createNamespacedRole({
      namespace,
      body: manifests.role,
      ...APPLIED,
    }),
  );
  await attempt("create controller role binding", () =>
    clients.rbac.createNamespacedRoleBinding({
      namespace,
      body: manifests.roleBinding,
      ...APPLIED,
    }),
  );
}

function runPreparationOperations(
  clients: RunControlClients,
): Pick<
  RunControlApi,
  | "createRunRoot"
  | "createExperimentAndQueue"
  | "createControllerAccess"
  | "createRouterService"
  | "startController"
> {
  return {
    createRunRoot: (input) => createRunRoot(clients, input),
    createExperimentAndQueue: (namespace, manifests) =>
      createExperimentAndQueue(clients, namespace, manifests),
    createControllerAccess: (namespace, manifests) =>
      createControllerAccess(clients, namespace, manifests),
    createRouterService: async (namespace, manifests) => {
      await attempt("create router service", () =>
        clients.core.createNamespacedService({
          namespace,
          body: manifests.routerService,
          ...APPLIED,
        }),
      );
    },
    startController: async (namespace, manifests) => {
      await attempt("create controller job", () =>
        clients.batch.createNamespacedJob({
          namespace,
          body: manifests.controllerJob,
          ...APPLIED,
        }),
      );
    },
  };
}

function runObservationOperations(
  clients: RunControlClients,
): Pick<
  RunControlApi,
  | "readControllerJob"
  | "readControllerLogs"
  | "deleteRunNamespace"
  | "runNamespaceExists"
> {
  return {
    readControllerJob: async (namespace) =>
      jobObservation(
        await attempt("observe controller job", () =>
          clients.batch.readNamespacedJob({
            namespace,
            name: CONTROLLER_NAME,
          }),
        ),
      ),
    readControllerLogs: (namespace, tailLines, limitBytes) =>
      readControllerLogs(clients, namespace, tailLines, limitBytes),
    deleteRunNamespace: (namespace) =>
      attemptUnlessAbsent("delete run namespace", () =>
        clients.core.deleteNamespace({
          name: namespace,
          propagationPolicy: "Foreground",
        }),
      ),
    runNamespaceExists: async (namespace) => {
      try {
        await clients.core.readNamespace({ name: namespace });
        return true;
      } catch (cause) {
        if (isAbsent(cause)) {
          return false;
        }
        throw new KubernetesCallFailed("observe run namespace deletion", cause);
      }
    },
  };
}

/**
 * Build the live Kubernetes access one run-lifecycle worker attempt uses.
 * @returns Run-control operations backed by the worker Pod's service account.
 */
export function makeKubernetesRunControlApi(): RunControlApi {
  const clients = runControlClients();
  return Object.freeze({
    ...runPreparationOperations(clients),
    ...runObservationOperations(clients),
  });
}

interface InstallClients {
  readonly apps: AppsV1Api;
  readonly core: CoreV1Api;
  readonly rbac: RbacAuthorizationV1Api;
}

/** One object's three calls, each already bound to its own manifest. */
interface InstalledObjectApi {
  readonly read: () => Promise<{ metadata?: V1ObjectMeta }>;
  readonly create: () => Promise<unknown>;
  readonly replace: () => Promise<unknown>;
}

async function installOne(
  operation: string,
  manifest: { metadata?: V1ObjectMeta },
  api: InstalledObjectApi,
): Promise<void> {
  let existing: { metadata?: V1ObjectMeta };
  try {
    existing = await api.read();
  } catch (cause) {
    if (!isAbsent(cause)) {
      throw new KubernetesCallFailed(`read ${operation}`, cause);
    }
    await attempt(`create ${operation}`, api.create);
    return;
  }
  const metadata = manifest.metadata ?? {};
  metadata.resourceVersion = existing.metadata?.resourceVersion;
  manifest.metadata = metadata;
  await attempt(`replace ${operation}`, api.replace);
}

const NAMED_WORKER = Object.freeze({
  name: RUN_WORKER_NAME,
  namespace: SYSTEM_NAMESPACE,
} as const);

function namespaceApi(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): InstalledObjectApi {
  return {
    read: () => clients.core.readNamespace({ name: SYSTEM_NAMESPACE }),
    create: () =>
      clients.core.createNamespace({ body: manifests.namespace, ...APPLIED }),
    replace: () =>
      clients.core.replaceNamespace({
        name: SYSTEM_NAMESPACE,
        body: manifests.namespace,
        ...APPLIED,
      }),
  };
}

function serviceAccountApi(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): InstalledObjectApi {
  return {
    read: () => clients.core.readNamespacedServiceAccount(NAMED_WORKER),
    create: () =>
      clients.core.createNamespacedServiceAccount({
        namespace: SYSTEM_NAMESPACE,
        body: manifests.serviceAccount,
        ...APPLIED,
      }),
    replace: () =>
      clients.core.replaceNamespacedServiceAccount({
        ...NAMED_WORKER,
        body: manifests.serviceAccount,
        ...APPLIED,
      }),
  };
}

function clusterRoleApi(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): InstalledObjectApi {
  return {
    read: () => clients.rbac.readClusterRole({ name: RUN_WORKER_NAME }),
    create: () =>
      clients.rbac.createClusterRole({
        body: manifests.clusterRole,
        ...APPLIED,
      }),
    replace: () =>
      clients.rbac.replaceClusterRole({
        name: RUN_WORKER_NAME,
        body: manifests.clusterRole,
        ...APPLIED,
      }),
  };
}

function clusterRoleBindingApi(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): InstalledObjectApi {
  return {
    read: () => clients.rbac.readClusterRoleBinding({ name: RUN_WORKER_NAME }),
    create: () =>
      clients.rbac.createClusterRoleBinding({
        body: manifests.clusterRoleBinding,
        ...APPLIED,
      }),
    replace: () =>
      clients.rbac.replaceClusterRoleBinding({
        name: RUN_WORKER_NAME,
        body: manifests.clusterRoleBinding,
        ...APPLIED,
      }),
  };
}

function deploymentApi(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): InstalledObjectApi {
  return {
    read: () => clients.apps.readNamespacedDeployment(NAMED_WORKER),
    create: () =>
      clients.apps.createNamespacedDeployment({
        namespace: SYSTEM_NAMESPACE,
        body: manifests.deployment,
        ...APPLIED,
      }),
    replace: () =>
      clients.apps.replaceNamespacedDeployment({
        ...NAMED_WORKER,
        body: manifests.deployment,
        ...APPLIED,
      }),
  };
}

function installedObjectApis(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): Readonly<Record<RunWorkerObject, InstalledObjectApi>> {
  return {
    namespace: namespaceApi(clients, manifests),
    serviceAccount: serviceAccountApi(clients, manifests),
    clusterRole: clusterRoleApi(clients, manifests),
    clusterRoleBinding: clusterRoleBindingApi(clients, manifests),
    deployment: deploymentApi(clients, manifests),
  };
}

function installClients(profile: KubernetesExecutionProfile): InstallClients {
  const config = new KubeConfig();
  config.loadFromDefault();
  if (profile.kind === "gke") {
    if (config.getContextObject(profile.kubeContext) === null) {
      throw new KubernetesCallFailed("select configured kubeconfig context");
    }
    config.setCurrentContext(profile.kubeContext);
  }
  return {
    apps: config.makeApiClient(AppsV1Api),
    core: config.makeApiClient(CoreV1Api),
    rbac: config.makeApiClient(RbacAuthorizationV1Api),
  };
}

/**
 * Build the live host-side access used to install the cluster's run worker.
 * @param options Host-selected image, Temporal endpoint, queue, and profile.
 * @returns Install operations against the profile's cluster.
 */
export function makeKubernetesRunWorkerInstallApi(
  options: RunWorkerOptions,
): RunWorkerInstallApi {
  const clients = installClients(options.profile);
  const manifests = runWorkerManifests(options);
  const apis = installedObjectApis(clients, manifests);
  return Object.freeze({
    install: (object: RunWorkerObject) =>
      installOne(`run worker ${object}`, manifests[object], apis[object]),
    readWorkerAvailability: async () => {
      const deployment = await attempt("observe run worker", () =>
        clients.apps.readNamespacedDeployment({
          name: RUN_WORKER_NAME,
          namespace: SYSTEM_NAMESPACE,
        }),
      );
      return {
        generation: deployment.metadata?.generation ?? 0,
        observedGeneration: deployment.status?.observedGeneration ?? -1,
        availableReplicas: deployment.status?.availableReplicas ?? 0,
      };
    },
    wait: (milliseconds: number) => delay(milliseconds),
  });
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Promise-native Kubernetes boundaries. */
