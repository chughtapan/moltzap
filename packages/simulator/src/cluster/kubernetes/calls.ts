/**
 * @file Every Kubernetes API call the simulator makes: the run-scoped society
 * operations the controller drives, the run-lifecycle operations the worker
 * drives, and the control-plane installation the host drives.
 */

import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  RbacAuthorizationV1Api,
  setHeaderOptions,
  type V1Job,
  type V1JobCondition,
} from "@kubernetes/client-node";
import { Cause, Duration, Effect, Schema } from "effect";
import { connect } from "node:net";
import type { KubernetesExecutionProfile } from "../profile.js";
import type { RunSocietyWorkflowInput } from "../reclaim.js";
import { ClusterError, clusterError } from "../cluster.js";
import {
  CONTROLLER_NAME,
  type OwnedRunControlManifests,
  RUN_WORKER_NAME,
  runNamespaceManifest,
  runOwnerManifest,
  runWorkerManifests,
  type RunWorkerManifests,
  type RunWorkerOptions,
  SYSTEM_NAMESPACE,
} from "./objects.js";

const BRIDGE_PROBE_TIMEOUT = Duration.seconds(2);

/** Kubernetes status for an object the cluster does not have. */
const ABSENT = 404;

/** Environment variable overriding how long one call may go unanswered. */
export const KUBERNETES_CALL_TIMEOUT_VARIABLE =
  "MOLTZAP_KUBERNETES_CALL_TIMEOUT_MS";
/** Default finite deadline for one Kubernetes response. */
export const DEFAULT_KUBERNETES_CALL_TIMEOUT_MS = 30_000;

/**
 * Resolve the finite deadline shared by Kubernetes calls in one process.
 *
 * The module loads before a submission exists, so an unusable override falls
 * back to the default instead of producing a submission failure with nowhere
 * to report it.
 *
 * @param environment Process environment visible to the submitter or worker.
 * @returns A positive deadline, defaulting to thirty seconds.
 */
export function kubernetesCallTimeout(
  environment: Readonly<Record<string, string | undefined>>,
): Duration.Duration {
  const configured = Number(
    environment[KUBERNETES_CALL_TIMEOUT_VARIABLE] ?? Number.NaN,
  );
  return Duration.millis(
    Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_KUBERNETES_CALL_TIMEOUT_MS,
  );
}

/**
 * One process-wide deadline covers the submitter, worker, and controller call
 * families without adding configuration parameters to their capability APIs.
 */
// eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- Module initialization captures the process environment before any Kubernetes call exists.
const KUBERNETES_CALL_TIMEOUT = kubernetesCallTimeout(process.env);

/** Field ownership and strict validation applied to every write. */
const APPLIED = Object.freeze({
  fieldManager: "moltzap-simulator",
  fieldValidation: "Strict",
} as const);

/** Failure of one Kubernetes call, carrying the status but never the body. */
export class KubernetesCallFailed extends Error {
  override readonly name = "KubernetesCallFailed";

  /** Whether the cluster answered that the object is not there. */
  readonly absent: boolean;

  constructor(operation: string, cause?: unknown) {
    const status = cause instanceof ApiException ? cause.code : 0;
    super(
      callDetail(operation, status, cause instanceof Cause.TimeoutException),
    );
    this.absent = status === ABSENT;
  }
}

/**
 * Run one Kubernetes API call within a finite deadline.
 *
 * The Kubernetes client has no request deadline. An accepted connection can
 * otherwise wait forever when a control plane or tunnel stops answering.
 *
 * @param operation Operator-facing description of the call.
 * @param evaluate Client request already bound to its arguments.
 * @param bound Maximum time the cluster has to answer.
 * @returns The Kubernetes result.
 * @failure KubernetesCallFailed when the call is refused or unanswered.
 */
export function kubernetesCall<Result>(
  operation: string,
  evaluate: () => PromiseLike<Result>,
  bound: Duration.Duration = KUBERNETES_CALL_TIMEOUT,
): Effect.Effect<Result, KubernetesCallFailed> {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new KubernetesCallFailed(operation, cause),
  }).pipe(
    Effect.timeoutFail({
      duration: bound,
      onTimeout: () =>
        new KubernetesCallFailed(operation, new Cause.TimeoutException()),
    }),
  );
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

/**
 * Build the live host-side access used to install the cluster's run worker.
 * @param options Host-selected image, Temporal endpoint, queue, and profile.
 * @returns Install operations against the profile's cluster.
 */
export function makeKubernetesRunWorkerInstallApi(
  options: RunWorkerOptions,
): RunWorkerInstallApi {
  const clients = installClients(options.profile);
  const applies = installedObjectApplies(clients, runWorkerManifests(options));
  return Object.freeze({
    install: (object: RunWorkerObject) =>
      kubernetesCall(`apply run worker ${object}`, applies[object]).pipe(
        Effect.asVoid,
      ),
    readWorkerAvailability: () =>
      kubernetesCall("observe run worker", () =>
        clients.apps.readNamespacedDeployment({
          name: RUN_WORKER_NAME,
          namespace: SYSTEM_NAMESPACE,
        }),
      ).pipe(Effect.map(workerAvailabilityOf)),
    wait: (milliseconds: number) => Effect.sleep(Duration.millis(milliseconds)),
  });
}

/**
 * Describe whether Kubernetes refused a call or never answered it.
 *
 * Status zero represents the absence of any Kubernetes response. Timeout is
 * distinct from absence so cleanup never treats an unanswered delete as a
 * confirmed missing object.
 *
 * @param operation Operator-facing description of the call.
 * @param status Kubernetes response status, or zero when none arrived.
 * @param unanswered Whether the finite deadline elapsed.
 * @returns A body-free diagnostic suitable for the public error boundary.
 */
function callDetail(
  operation: string,
  status: number,
  unanswered: boolean,
): string {
  if (unanswered) {
    return `${operation} did not answer in time`;
  }
  return status === 0
    ? `${operation} failed`
    : `${operation} failed (Kubernetes ${String(status)})`;
}

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

/**
 * Keep the existing cluster capability error while retaining call detail.
 * @param failure Internal typed call failure.
 * @returns The public cluster-seam failure.
 */
function societyFailure(failure: KubernetesCallFailed): ClusterError {
  return new ClusterError({ detail: failure.message });
}

function request<A>(operation: string, evaluate: () => PromiseLike<A>) {
  return kubernetesCall(operation, evaluate).pipe(
    Effect.mapError(societyFailure),
  );
}

function ignoreAbsent(
  operation: string,
  evaluate: () => PromiseLike<unknown>,
): Effect.Effect<void, ClusterError> {
  return attemptUnlessAbsent(operation, evaluate).pipe(
    Effect.mapError(societyFailure),
  );
}

function attemptUnlessAbsent(
  operation: string,
  evaluate: () => PromiseLike<unknown>,
): Effect.Effect<void, KubernetesCallFailed> {
  return kubernetesCall(operation, evaluate).pipe(
    Effect.catchIf(
      (failure) => failure.absent,
      () => Effect.void,
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

function decode<A, I, R>(
  operation: string,
  schema: Schema.Schema<A, I, R>,
  value: unknown,
): Effect.Effect<A, ClusterError, R> {
  return Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError((cause) => clusterError(operation, cause)),
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

interface ConditionedObservation {
  readonly metadata: { readonly generation?: number };
  readonly status?: { readonly conditions?: readonly KubernetesCondition[] };
}

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
  readonly replicas: number;
  readonly updatedReplicas: number;
  readonly availableReplicas: number;
}

// An unobserved generation reads as -1, never as ready.
function workerAvailabilityOf(deployment: {
  readonly metadata?: { readonly generation?: number };
  readonly status?: {
    readonly observedGeneration?: number;
    readonly replicas?: number;
    readonly updatedReplicas?: number;
    readonly availableReplicas?: number;
  };
}): WorkerAvailability {
  const { generation = 0 } = deployment.metadata ?? {};
  const {
    observedGeneration = -1,
    replicas = 0,
    updatedReplicas = 0,
    availableReplicas = 0,
  } = deployment.status ?? {};
  return {
    generation,
    observedGeneration,
    replicas,
    updatedReplicas,
    availableReplicas,
  };
}

/** One installable member of the cluster's run-worker control plane. */
export type RunWorkerObject = keyof RunWorkerManifests;

/** Kubernetes access the Temporal activity needs for one run's lifetime. */
export interface RunControlApi {
  /** Create the run's Namespace and immutable owner; yields the owner UID. */
  readonly createRunRoot: (
    input: RunSocietyWorkflowInput,
  ) => Effect.Effect<string, KubernetesCallFailed>;
  readonly createExperimentAndQueue: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly createControllerAccess: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly createRouterService: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly startController: (
    namespace: string,
    manifests: OwnedRunControlManifests,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly readControllerJob: (
    namespace: string,
  ) => Effect.Effect<JobObservation, KubernetesCallFailed>;
  /** Bounded controller output, or nothing when the Pod cannot be read. */
  readonly readControllerLogs: (
    namespace: string,
    tailLines: number,
    limitBytes: number,
  ) => Effect.Effect<string | undefined, KubernetesCallFailed>;
  readonly deleteRunNamespace: (
    namespace: string,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly runNamespaceExists: (
    namespace: string,
  ) => Effect.Effect<boolean, KubernetesCallFailed>;
}

/** Kubernetes access the host needs to install the cluster's run worker. */
export interface RunWorkerInstallApi {
  /**
   * Declare one control-plane object as this manager owns it.
   *
   * The worker outlives every submission, so each install meets an object that
   * is either absent or a previous revision of itself; applying states the
   * revision the submission wants without asking first which one is there.
   * Ownership is what makes that safe: a field some other manager took over is
   * refused as a conflict rather than silently overwritten.
   */
  readonly install: (
    object: RunWorkerObject,
  ) => Effect.Effect<void, KubernetesCallFailed>;
  readonly readWorkerAvailability: () => Effect.Effect<
    WorkerAvailability,
    KubernetesCallFailed
  >;
  /** Sleep between rollout observations while the worker starts. */
  readonly wait: (milliseconds: number) => Effect.Effect<void>;
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

function createRunRoot(
  clients: RunControlClients,
  input: RunSocietyWorkflowInput,
): Effect.Effect<string, KubernetesCallFailed> {
  return Effect.gen(function* () {
    yield* kubernetesCall("create run namespace", () =>
      clients.core.createNamespace({
        body: runNamespaceManifest(input),
        ...APPLIED,
      }),
    );
    const root = yield* kubernetesCall("create run owner", () =>
      clients.core.createNamespacedConfigMap({
        namespace: input.namespace,
        body: runOwnerManifest(input),
        ...APPLIED,
      }),
    );
    const ownerUid = root.metadata?.uid;
    if (ownerUid === undefined || ownerUid.length === 0) {
      return yield* Effect.fail(new KubernetesCallFailed("read run owner UID"));
    }
    return ownerUid;
  });
}

// A Pod already being deleted is skipped: its log stream ends wherever the
// eviction cut it, which would read as a controller that stopped on its own.
function readControllerLogs(
  clients: RunControlClients,
  namespace: string,
  tailLines: number,
  limitBytes: number,
): Effect.Effect<string | undefined, KubernetesCallFailed> {
  return Effect.gen(function* () {
    const pods = yield* kubernetesCall("observe controller pod", () =>
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
    const output = yield* kubernetesCall("read controller log", () =>
      clients.core.readNamespacedPodLog({
        namespace,
        name: podName,
        container: CONTROLLER_NAME,
        tailLines,
        limitBytes,
      }),
    );
    return output.length === 0 ? undefined : output;
  });
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

function createExperimentAndQueue(
  clients: RunControlClients,
  namespace: string,
  manifests: OwnedRunControlManifests,
): Effect.Effect<void, KubernetesCallFailed> {
  return Effect.gen(function* () {
    yield* kubernetesCall("create experiment module", () =>
      clients.core.createNamespacedConfigMap({
        namespace,
        body: manifests.experiment,
        ...APPLIED,
      }),
    );
    yield* kubernetesCall("create run queue", () =>
      clients.custom.createNamespacedCustomObject({
        group: KUEUE_GROUP,
        version: KUEUE_VERSION,
        namespace,
        plural: LOCAL_QUEUES,
        body: manifests.localQueue,
        ...APPLIED,
      }),
    );
  });
}

function createControllerAccess(
  clients: RunControlClients,
  namespace: string,
  manifests: OwnedRunControlManifests,
): Effect.Effect<void, KubernetesCallFailed> {
  return Effect.gen(function* () {
    yield* kubernetesCall("create controller service account", () =>
      clients.core.createNamespacedServiceAccount({
        namespace,
        body: manifests.serviceAccount,
        ...APPLIED,
      }),
    );
    yield* kubernetesCall("create controller role", () =>
      clients.rbac.createNamespacedRole({
        namespace,
        body: manifests.role,
        ...APPLIED,
      }),
    );
    yield* kubernetesCall("create controller role binding", () =>
      clients.rbac.createNamespacedRoleBinding({
        namespace,
        body: manifests.roleBinding,
        ...APPLIED,
      }),
    );
  });
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
    createRouterService: (namespace, manifests) =>
      kubernetesCall("create router service", () =>
        clients.core.createNamespacedService({
          namespace,
          body: manifests.routerService,
          ...APPLIED,
        }),
      ).pipe(Effect.asVoid),
    startController: (namespace, manifests) =>
      kubernetesCall("create controller job", () =>
        clients.batch.createNamespacedJob({
          namespace,
          body: manifests.controllerJob,
          ...APPLIED,
        }),
      ).pipe(Effect.asVoid),
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
    readControllerJob: (namespace) =>
      kubernetesCall("observe controller job", () =>
        clients.batch.readNamespacedJob({
          namespace,
          name: CONTROLLER_NAME,
        }),
      ).pipe(Effect.map(jobObservation)),
    readControllerLogs: (namespace, tailLines, limitBytes) =>
      readControllerLogs(clients, namespace, tailLines, limitBytes),
    deleteRunNamespace: (namespace) =>
      attemptUnlessAbsent("delete run namespace", () =>
        clients.core.deleteNamespace({
          name: namespace,
          propagationPolicy: "Foreground",
        }),
      ),
    runNamespaceExists: (namespace) =>
      kubernetesCall("observe run namespace deletion", () =>
        clients.core.readNamespace({ name: namespace }),
      ).pipe(
        Effect.as(true),
        Effect.catchIf(
          (failure) => failure.absent,
          () => Effect.succeed(false),
        ),
      ),
  };
}

interface InstallClients {
  readonly apps: AppsV1Api;
  readonly core: CoreV1Api;
  readonly rbac: RbacAuthorizationV1Api;
}

/** One object's apply call, already bound to the manifest it declares. */
type InstalledObjectApply = () => PromiseLike<unknown>;

const NAMED_WORKER = Object.freeze({
  name: RUN_WORKER_NAME,
  namespace: SYSTEM_NAMESPACE,
} as const);

/**
 * Field ownership plus the content type that makes a patch an apply. Ownership
 * is forced because an earlier submission's create owns these fields under
 * Update, which conflicts with an Apply even from the same manager. The run
 * worker's objects have no other writer.
 */
const APPLY = Object.freeze({ ...APPLIED, force: true } as const);
const APPLY_OPTIONS = setHeaderOptions(
  "Content-Type",
  PatchStrategy.ServerSideApply,
);

function installedObjectApplies(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): Readonly<Record<RunWorkerObject, InstalledObjectApply>> {
  return {
    namespace: () =>
      clients.core.patchNamespace(
        { name: SYSTEM_NAMESPACE, body: manifests.namespace, ...APPLY },
        APPLY_OPTIONS,
      ),
    serviceAccount: () =>
      clients.core.patchNamespacedServiceAccount(
        { ...NAMED_WORKER, body: manifests.serviceAccount, ...APPLY },
        APPLY_OPTIONS,
      ),
    clusterRole: () =>
      clients.rbac.patchClusterRole(
        { name: RUN_WORKER_NAME, body: manifests.clusterRole, ...APPLY },
        APPLY_OPTIONS,
      ),
    clusterRoleBinding: () =>
      clients.rbac.patchClusterRoleBinding(
        { name: RUN_WORKER_NAME, body: manifests.clusterRoleBinding, ...APPLY },
        APPLY_OPTIONS,
      ),
    deployment: () =>
      clients.apps.patchNamespacedDeployment(
        { ...NAMED_WORKER, body: manifests.deployment, ...APPLY },
        APPLY_OPTIONS,
      ),
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
