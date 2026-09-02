/**
 * @file Every Kubernetes object the simulator builds: the run's aggregate
 * admission and sandbox resources, the run-scoped control objects created
 * before the controller starts, and the cluster's long-lived run worker.
 */

import type {
  V1ClusterRole,
  V1ClusterRoleBinding,
  V1ConfigMap,
  V1Container,
  V1Deployment,
  V1Job,
  V1Namespace,
  V1OwnerReference,
  V1Role,
  V1RoleBinding,
  V1Service,
  V1ServiceAccount,
  V1Volume,
} from "@kubernetes/client-node";
import type { CredentialName, Image, Resources } from "../../agents/index.js";
import type { RunSocietyWorkflowInput } from "../reclaim.js";
import { ClusterError } from "../cluster.js";
import {
  encodeKubernetesExecutionProfile,
  type KubernetesExecutionProfile,
  type KubernetesPodPlacement,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
} from "../profile.js";
import {
  ADMISSION_CREDENTIAL_SECRET_KEY,
  AGENT_PRIVATE_KEY_SECRET_KEY,
  type AgentDaemonAuthority,
  DAEMON_MCP_PORT,
  type SocietyNetworkConfiguration,
} from "../society-network.js";

// safer-arch-ignore no-cross-domain-sibling-import: Kubernetes objects carry the agent and ledger identities the run gives them.

const MAX_KUEUE_POD_SETS = 8;
const BOOTSTRAP_INPUT_PATH = "/var/run/moltzap/secret";
const BOOTSTRAP_OUTPUT_PATH = "/var/run/moltzap/bootstrap";
const DAEMON_SECRET_SOURCE_PATH = "/var/run/moltzap/daemon-source";
const DAEMON_SECRET_PATH = "/var/run/moltzap/daemon";
const ENDPOINT_STATE_PATH = "/var/lib/moltzap/endpoint";
const MCP_URL = `http://127.0.0.1:${String(DAEMON_MCP_PORT)}/mcp`;

/** Root ConfigMap name shared with controller-created owner references. */
export const RUN_OWNER_NAME = "run";
/** The one container in a Sandbox Pod that runs the rendered application. */
export const APPLICATION_CONTAINER_NAME = "application";

/** Run root created by the Temporal activity before the controller starts. */
export interface KubernetesRunOwner {
  readonly name: string;
  readonly uid: string;
}

/** Private manifest shape built here and submitted through Kubernetes APIs. */
export type KubernetesManifest = Readonly<Record<string, unknown>>;

/** Capacity facts projected from one private container runtime. */
export interface RuntimeCapacitySlot {
  readonly image: string;
  readonly requests: Readonly<Record<string, string>>;
}

/**
 * The capacity one run reserves. A reservation that admits nothing would let a
 * run hold cluster ownership with no roster behind it, so the empty case is
 * spelled out of the type rather than refused after the fact.
 */
export type ReservedCapacity = readonly [
  RuntimeCapacitySlot,
  ...RuntimeCapacitySlot[],
];

/** Everything one Sandbox Pod template needs about a rendered application. */
export interface SandboxApplication {
  readonly image: Image;
  readonly resources: Resources;
  readonly entrypoint: readonly [string, ...string[]];
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials?: readonly CredentialName[];
  readonly port: number;
}

interface CapacityGroup {
  readonly image: string;
  readonly requests: Readonly<Record<string, string>>;
  count: number;
}

interface AggregateWorkloadInput {
  readonly namespace: string;
  readonly name: string;
  readonly queueName: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly owner: KubernetesRunOwner;
  readonly slots: ReservedCapacity;
  readonly placement?: KubernetesPodPlacement;
}

interface BootstrapSecretInput {
  readonly namespace: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly owner: KubernetesRunOwner;
  readonly data: Readonly<Record<string, string>>;
}

interface SandboxManifestInput {
  readonly namespace: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly owner: KubernetesRunOwner;
  readonly bootstrapSecretName: string;
  readonly supportImage: Image;
  readonly network: SocietyNetworkConfiguration;
  readonly daemon: Pick<AgentDaemonAuthority, "operationId" | "principalId">;
  readonly endpointStateClaimName: string;
  readonly agentName: string;
  readonly application: SandboxApplication;
  readonly credentialSecretKeys: Readonly<
    Record<CredentialName, string | undefined>
  >;
  readonly placement?: KubernetesPodPlacement;
}

/**
 * Build one immutable Kueue Workload for the complete roster.
 * @param input Run-scoped identity, queue, and credential-free capacity facts.
 * @returns Strict custom-resource manifest submitted to Kueue.
 */
export function aggregateWorkloadManifest(
  input: AggregateWorkloadInput,
): KubernetesManifest {
  const groups = groupCapacity(input.slots);
  if (groups.length > MAX_KUEUE_POD_SETS) {
    throw new ClusterError({
      detail: `aggregate capacity reservation has ${String(groups.length)} resource classes; Kueue accepts at most ${String(MAX_KUEUE_POD_SETS)}`,
    });
  }
  return {
    apiVersion: "kueue.x-k8s.io/v1beta2",
    kind: "Workload",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      active: true,
      queueName: input.queueName,
      podSets: workloadPodSets(groups, input.placement),
    },
  };
}

/**
 * Build the immutable per-agent bootstrap Secret.
 * @param input Run ownership plus opaque bootstrap file bytes.
 * @returns Core Kubernetes Secret manifest with base64-encoded data.
 */
export function bootstrapSecretManifest(
  input: BootstrapSecretInput,
): KubernetesManifest {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    immutable: true,
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(input.data).map(([name, content]) => [
        name,
        Buffer.from(content, "utf8").toString("base64"),
      ]),
    ),
  };
}

/**
 * Build one direct Agent Sandbox for a single roster application.
 * @param input Run ownership, bootstrap identity, and rendered application.
 * @returns Strict Agent Sandbox custom-resource manifest.
 */
export function sandboxManifest(
  input: SandboxManifestInput,
): KubernetesManifest {
  return {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      service: true,
      podTemplate: {
        metadata: { labels: input.labels },
        spec: sandboxPodSpec(input),
      },
    },
  };
}

/**
 * Build the Namespace that contains every Kubernetes object for one run.
 * @param input Workflow input carrying the caller-selected namespace and run ID.
 * @returns A Namespace manifest owned by the surrounding cluster authority.
 */
export function runNamespaceManifest(
  input: RunSocietyWorkflowInput,
): V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: input.namespace,
      annotations: runAnnotations(input.runId),
      labels: { "app.kubernetes.io/managed-by": "moltzap-simulator" },
    },
  };
}

/**
 * Build the root object whose UID owns the run's namespaced control objects.
 * @param input Workflow input carrying the target namespace and run ID.
 * @returns An immutable ConfigMap used only as the run ownership root.
 */
export function runOwnerManifest(input: RunSocietyWorkflowInput): V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    immutable: true,
    metadata: {
      name: RUN_OWNER_NAME,
      namespace: input.namespace,
      annotations: runAnnotations(input.runId),
    },
  };
}

/**
 * Build every owned object needed before the in-cluster controller starts.
 * @param input Serializable workflow input projected into Kubernetes manifests.
 * @param ownerUid UID returned by the run root ConfigMap creation.
 * @param profile Private storage and placement projection selected by the host.
 * @returns The complete set of namespaced control objects created before the Job.
 */
export function ownedRunControlManifests(
  input: RunSocietyWorkflowInput,
  ownerUid: string,
  profile: KubernetesExecutionProfile = LOCAL_KUBERNETES_EXECUTION_PROFILE,
): OwnedRunControlManifests {
  const owner = runOwnerReference(ownerUid);
  return {
    experiment: experimentManifest(input, owner),
    localQueue: localQueueManifest(input, owner),
    serviceAccount: controllerServiceAccount(input, owner),
    role: controllerRole(input, owner),
    roleBinding: controllerRoleBinding(input, owner),
    controllerService: controllerService(input, owner),
    controllerJob: controllerJob(input, owner, profile),
  };
}

/**
 * Build the cluster-resident worker that serves the run-lifecycle task queue.
 *
 * The worker is a Deployment rather than a process inside whichever host
 * submitted the run: the workflow's cleanup only runs where a worker is
 * polling, so a queue served by the submitter leaves every abandoned run's
 * namespace behind.
 *
 * @param options Host-selected image, Temporal endpoint, queue, and profile.
 * @returns The namespace, identity, permissions, and workload to install.
 */
export function runWorkerManifests(
  options: RunWorkerOptions,
): RunWorkerManifests {
  return {
    namespace: runWorkerNamespace(),
    serviceAccount: runWorkerServiceAccount(),
    clusterRole: runWorkerClusterRole(),
    clusterRoleBinding: runWorkerClusterRoleBinding(),
    deployment: runWorkerDeployment(options),
  };
}

function ownerReference(owner: KubernetesRunOwner) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    name: owner.name,
    uid: owner.uid,
    controller: true,
    blockOwnerDeletion: true,
  } as const;
}

function groupCapacity(
  slots: readonly RuntimeCapacitySlot[],
): readonly CapacityGroup[] {
  const groups = new Map<string, CapacityGroup>();
  for (const slot of slots) {
    const key = capacityKey(slot);
    const present = groups.get(key);
    if (present === undefined) {
      groups.set(key, {
        count: 1,
        image: slot.image,
        requests: slot.requests,
      });
    } else {
      present.count += 1;
    }
  }
  return [...groups.values()];
}

function capacityKey(slot: RuntimeCapacitySlot): string {
  return JSON.stringify(
    Object.entries(slot.requests).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function sandboxPodSpec(input: SandboxManifestInput) {
  return {
    ...podPlacement(input.placement),
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    restartPolicy: "Never",
    securityContext: {
      seccompProfile: { type: "RuntimeDefault" },
    },
    initContainers: [bootstrapContainer(input)],
    containers: [applicationContainer(input)],
    volumes: [
      {
        name: "bootstrap-input",
        secret: { secretName: input.bootstrapSecretName },
      },
      { name: "bootstrap-output", emptyDir: {} },
      {
        name: "daemon-secret",
        secret: {
          secretName: input.bootstrapSecretName,
          items: [
            {
              key: AGENT_PRIVATE_KEY_SECRET_KEY,
              path: AGENT_PRIVATE_KEY_SECRET_KEY,
              mode: 0o400,
            },
            {
              key: ADMISSION_CREDENTIAL_SECRET_KEY,
              path: ADMISSION_CREDENTIAL_SECRET_KEY,
              mode: 0o400,
            },
          ],
        },
      },
      {
        name: "endpoint-state",
        persistentVolumeClaim: { claimName: input.endpointStateClaimName },
      },
    ],
  };
}

function podPlacement(placement?: KubernetesPodPlacement) {
  return placement === undefined
    ? {}
    : {
        nodeSelector: { ...placement.nodeSelector },
        tolerations: placement.tolerations.map((toleration) => ({
          ...toleration,
        })),
      };
}

function workloadPodSets(
  groups: readonly CapacityGroup[],
  placement?: KubernetesPodPlacement,
) {
  return groups.map((group, index) => ({
    name: `runtime-${String(index + 1)}`,
    count: group.count,
    template: {
      spec: {
        ...podPlacement(placement),
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        containers: [
          {
            name: "application",
            image: group.image,
            resources: { requests: group.requests },
          },
        ],
      },
    },
  }));
}

function bootstrapContainer(input: SandboxManifestInput) {
  return {
    name: "bootstrap",
    image: input.supportImage,
    command: ["node", "/opt/moltzap/dist/cluster/bootstrap.js"],
    args: [
      "--manifest",
      `${BOOTSTRAP_INPUT_PATH}/manifest.json`,
      "--source",
      BOOTSTRAP_INPUT_PATH,
      "--output",
      BOOTSTRAP_OUTPUT_PATH,
    ],
    volumeMounts: [
      {
        name: "bootstrap-input",
        mountPath: BOOTSTRAP_INPUT_PATH,
        readOnly: true,
      },
      { name: "bootstrap-output", mountPath: BOOTSTRAP_OUTPUT_PATH },
    ],
  };
}

function applicationContainer(input: SandboxManifestInput) {
  const [command, ...args] = input.application.entrypoint;
  return {
    name: APPLICATION_CONTAINER_NAME,
    image: input.application.image,
    command: [command],
    args,
    env: applicationEnvironment(input),
    ports: [
      {
        name: `gateway-${String(input.application.port)}`,
        containerPort: input.application.port,
        protocol: "TCP",
      },
    ],
    resources: { requests: resourceRequests(input.application.resources) },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: {
        add: ["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"],
        drop: ["ALL"],
      },
      runAsNonRoot: false,
      runAsUser: 0,
    },
    terminationMessagePolicy: "FallbackToLogsOnError",
    volumeMounts: [
      {
        name: "bootstrap-output",
        mountPath: BOOTSTRAP_OUTPUT_PATH,
      },
      {
        name: "daemon-secret",
        mountPath: DAEMON_SECRET_SOURCE_PATH,
        readOnly: true,
      },
      { name: "endpoint-state", mountPath: ENDPOINT_STATE_PATH },
    ],
  };
}

function applicationEnvironment(input: SandboxManifestInput) {
  const credentials = (input.application.credentials ?? [])
    .map((name) => {
      const key = input.credentialSecretKeys[name];
      return key === undefined
        ? undefined
        : {
            name,
            valueFrom: {
              secretKeyRef: {
                name: input.bootstrapSecretName,
                key,
                optional: false,
              },
            },
          };
    })
    .filter((entry) => entry !== undefined);
  return [
    ...Object.entries({
      ...input.application.environment,
      MOLTZAP_MCP_URL: MCP_URL,
      MOLTZAP_REGISTRATION_AGENT_NAME: input.agentName,
      MOLTZAP_REGISTRATION_OPERATION_ID: input.daemon.operationId,
      MOLTZAP_REGISTRATION_PRINCIPAL_ID: input.daemon.principalId,
      MOLTZAPD_ADMISSION_CREDENTIAL_FILE:
        DAEMON_SECRET_PATH + "/" + ADMISSION_CREDENTIAL_SECRET_KEY,
      MOLTZAPD_AGENT_PRIVATE_KEY_FILE:
        DAEMON_SECRET_PATH + "/" + AGENT_PRIVATE_KEY_SECRET_KEY,
      MOLTZAPD_MCP_PORT: String(DAEMON_MCP_PORT),
      MOLTZAPD_REGISTRY_ORIGIN: input.network.registryOrigin,
      MOLTZAPD_REGISTRY_SIGNER_PUBLIC_KEY:
        input.network.registrySignerPublicKeyJson,
      MOLTZAPD_ROUTER_ORIGIN: input.network.routerOrigin,
      MOLTZAPD_STATE_DIRECTORY: ENDPOINT_STATE_PATH,
    })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value })),
    ...credentials,
  ];
}

function resourceRequests(
  resources: Resources,
): Readonly<Record<string, string>> {
  return {
    cpu: `${String(resources.cpuMillis)}m`,
    memory: String(resources.memoryBytes),
    "ephemeral-storage": String(resources.ephemeralStorageBytes),
  };
}

/** ConfigMap containing the mounted experiment module. */
export const EXPERIMENT_CONFIG_NAME = "experiment";
/** Run-local queue consumed by the aggregate Kueue Workload. */
export const LOCAL_QUEUE_NAME = "society";
/** Profile-owned ClusterQueue selected by every run-local queue. */
export const CLUSTER_QUEUE_NAME = "moltzap";
/** Shared ServiceAccount, RBAC, and Job name for the controller. */
export const CONTROLLER_NAME = "controller";
/** Run-private post-Router fault proxy port exposed only inside the namespace. */
export const ROUTER_FAULT_PROXY_PORT = 43_120;
/** Namespace holding the cluster's long-lived simulator control plane. */
export const SYSTEM_NAMESPACE = "moltzap-system";
/** ServiceAccount, RBAC, and Deployment name for the run-lifecycle worker. */
export const RUN_WORKER_NAME = "run-worker";
/** Temporal endpoint a Pod in this cluster reaches the local server on. */
export const IN_CLUSTER_TEMPORAL_ADDRESS = `temporal.${SYSTEM_NAMESPACE}.svc.cluster.local:7233`;

const RUN_WORKER_ENTRYPOINT = "/opt/moltzap/dist/cluster/temporal.js";
/** File created only while the in-cluster Temporal worker is polling. */
export const RUN_WORKER_READY_PATH = "/home/node/.moltzap-run-worker-ready";
/**
 * Delay held before the worker Pod is signalled, in seconds.
 *
 * The worker's controller activity beats every 10 seconds against a 60-second
 * heartbeat deadline. Holding SIGTERM for longer than one beat lets an attempt
 * that is mid-interval signal once more before the process is asked to stop, so
 * a roll cannot fail an attempt that was still alive when the Pod was deleted.
 */
export const RUN_WORKER_PRESTOP_SECONDS = 15;
/**
 * Time the worker Pod has to stop before it is killed, in seconds.
 *
 * The rest of the heartbeat deadline, so the SDK's own shutdown has room after
 * the pre-stop delay returns rather than being killed at the default 30.
 */
export const RUN_WORKER_TERMINATION_GRACE_SECONDS = 60;
const CONTROLLER_ENTRYPOINT = "/opt/moltzap/dist/cluster/controller/main.js";
const EXPERIMENT_DIRECTORY = "/opt/moltzap/experiment";
const EXPERIMENT_PATH = `${EXPERIMENT_DIRECTORY}/main.mjs`;
const LOCAL_LEDGER_DIRECTORY = "/var/lib/moltzap/ledger";
const CONTROLLER_USER_ID = 1_000;
const GKE_GCS_FUSE_ANNOTATION = "gke-gcsfuse/volumes";
const GKE_GCS_FUSE_DRIVER = "gcsfuse.csi.storage.gke.io";
const GKE_GCS_FUSE_MOUNT_OPTIONS =
  "uid=1000,gid=1000,file-mode=0640,dir-mode=0750";
const GKE_ARTIFACT_MOUNT_PATH = "/var/lib/moltzap-artifacts";

/** Objects created after the run root establishes owner identity. */
export interface OwnedRunControlManifests {
  readonly experiment: V1ConfigMap;
  readonly localQueue: KubernetesManifest;
  readonly serviceAccount: V1ServiceAccount;
  readonly role: V1Role;
  readonly roleBinding: V1RoleBinding;
  readonly controllerService: V1Service;
  readonly controllerJob: V1Job;
}

function runAnnotations(runId: string): Readonly<Record<string, string>> {
  return { "moltzap.dev/run-id": runId };
}

function controllerJob(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
  profile: KubernetesExecutionProfile,
): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: CONTROLLER_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: {
          labels: controllerLabels(),
          ...(profile.kind === "gke"
            ? { annotations: { [GKE_GCS_FUSE_ANNOTATION]: "true" } }
            : {}),
        },
        spec: {
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          restartPolicy: "Never",
          serviceAccountName: CONTROLLER_NAME,
          initContainers: [ledgerPermissionsContainer(input)],
          containers: [controllerContainer(input, owner, profile)],
          volumes: controllerVolumes(input, profile),
        },
      },
    },
  };
}

function controllerService(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: CONTROLLER_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    spec: {
      selector: controllerLabels(),
      ports: [
        {
          name: "router-fault-proxy",
          port: ROUTER_FAULT_PROXY_PORT,
          targetPort: ROUTER_FAULT_PROXY_PORT,
          protocol: "TCP",
        },
      ],
    },
  };
}

function controllerContainer(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
  profile: KubernetesExecutionProfile,
): V1Container {
  return {
    name: CONTROLLER_NAME,
    image: input.controllerImage,
    command: ["node", CONTROLLER_ENTRYPOINT],
    ports: [
      {
        name: "router-proxy",
        containerPort: ROUTER_FAULT_PROXY_PORT,
        protocol: "TCP",
      },
    ],
    env: controllerEnvironment(input, owner.uid, profile),
    terminationMessagePolicy: "FallbackToLogsOnError",
    volumeMounts: [
      {
        name: "experiment",
        mountPath: EXPERIMENT_DIRECTORY,
        readOnly: true,
      },
      {
        name: "ledger",
        mountPath: LOCAL_LEDGER_DIRECTORY,
      },
      ...(profile.kind === "gke"
        ? [
            {
              name: "artifacts",
              mountPath: GKE_ARTIFACT_MOUNT_PATH,
            },
          ]
        : []),
    ],
  };
}

function controllerLabels(): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/name": "moltzap-simulator-controller",
    "app.kubernetes.io/managed-by": "moltzap-simulator",
  };
}

function runOwnerReference(uid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    name: RUN_OWNER_NAME,
    uid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

function controllerEnvironment(
  input: RunSocietyWorkflowInput,
  ownerUid: string,
  profile: KubernetesExecutionProfile,
) {
  return [
    { name: "MOLTZAP_RUN_NAMESPACE", value: input.namespace },
    { name: "MOLTZAP_RUN_QUEUE", value: LOCAL_QUEUE_NAME },
    { name: "MOLTZAP_RUN_OWNER_NAME", value: RUN_OWNER_NAME },
    { name: "MOLTZAP_RUN_OWNER_UID", value: ownerUid },
    { name: "MOLTZAP_SUPPORT_IMAGE", value: input.supportImage },
    ...optionalEnvironment("MOLTZAP_APPLICATION_IMAGE", input.applicationImage),
    ...optionalEnvironment(
      "MOLTZAP_RUNTIME_CREDENTIALS",
      input.runtimeCredentials === undefined
        ? undefined
        : JSON.stringify(input.runtimeCredentials),
    ),
    { name: "MOLTZAP_EXPERIMENT_MODULE", value: EXPERIMENT_PATH },
    ...optionalEnvironment(
      "MOLTZAP_STARTUP_TIMEOUT_MS",
      input.startupTimeoutMs?.toString(),
    ),
    ...optionalEnvironment(
      "MOLTZAP_ADMISSION_TIMEOUT_MS",
      input.admissionTimeoutMs?.toString(),
    ),
    ...optionalEnvironment("MOLTZAP_COHORT_SIZE", input.cohortSize?.toString()),
    { name: "MOLTZAP_LEDGER_DIRECTORY", value: LOCAL_LEDGER_DIRECTORY },
    ...profileControllerEnvironment(input, profile),
  ];
}

// An input the submission did not set is left unset, so the controller's own
// default applies rather than a second copy of it here.
function optionalEnvironment(name: string, value?: string) {
  return value === undefined ? [] : [{ name, value }];
}

function profileControllerEnvironment(
  input: RunSocietyWorkflowInput,
  profile: KubernetesExecutionProfile,
) {
  return profile.kind === "gke"
    ? [
        {
          name: "MOLTZAP_LEDGER_EXPORT_DIRECTORY",
          value: `${GKE_ARTIFACT_MOUNT_PATH}/${input.namespace}/ledger`,
        },
        {
          name: "MOLTZAP_ROSTER_PLACEMENT",
          value: JSON.stringify(profile.rosterPlacement),
        },
      ]
    : [];
}

function experimentManifest(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1ConfigMap {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    immutable: true,
    metadata: {
      name: EXPERIMENT_CONFIG_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    data: { "main.mjs": input.experimentModule },
  };
}

function localQueueManifest(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): KubernetesManifest {
  return {
    apiVersion: "kueue.x-k8s.io/v1beta2",
    kind: "LocalQueue",
    metadata: {
      name: LOCAL_QUEUE_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    spec: { clusterQueue: CLUSTER_QUEUE_NAME },
  };
}

function controllerServiceAccount(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: CONTROLLER_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
  };
}

/**
 * The controller's complete authority inside its own run namespace.
 *
 * `pods/exec` is the one resource that reaches inside an application
 * container: harvesting a workspace file runs a shell there after the customer
 * program ends. The client opens that session over a WebSocket, whose HTTP
 * upgrade is a GET the API server authorizes as the `get` verb, while the
 * SPDY form kubectl uses is a POST authorized as `create`; the rule grants
 * both so the read does not depend on which transport the client picks. The
 * grant is namespace-scoped, owned by the run root, and deleted with the run,
 * so it never outlives the society it can read.
 * @param input Workflow input carrying the run namespace.
 * @param owner Run root every namespaced control object hangs from.
 * @returns The Role bound to the controller's service account.
 */
// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The controller's closed RBAC grant stays in one manifest so reviewers can audit the exact authority set.
function controllerRole(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1Role {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: {
      name: CONTROLLER_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    rules: [
      {
        apiGroups: ["kueue.x-k8s.io"],
        resources: ["workloads"],
        verbs: ["create", "get", "delete"],
      },
      {
        apiGroups: ["agents.x-k8s.io"],
        resources: ["sandboxes"],
        verbs: ["create", "get", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["secrets", "persistentvolumeclaims", "services"],
        verbs: ["create", "delete"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        verbs: ["create", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: [RUN_OWNER_NAME],
        verbs: ["get", "delete"],
      },
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["get", "list"],
      },
      {
        apiGroups: [""],
        resources: ["pods/log"],
        verbs: ["get"],
      },
      {
        apiGroups: [""],
        resources: ["pods/exec"],
        verbs: ["create", "get"],
      },
    ],
  };
}

function controllerRoleBinding(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1RoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: CONTROLLER_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: CONTROLLER_NAME,
    },
    subjects: [
      {
        apiGroup: "",
        kind: "ServiceAccount",
        name: CONTROLLER_NAME,
        namespace: input.namespace,
      },
    ],
  };
}

function controllerVolumes(
  input: RunSocietyWorkflowInput,
  profile: KubernetesExecutionProfile,
): V1Volume[] {
  return [
    {
      name: "experiment",
      configMap: {
        name: EXPERIMENT_CONFIG_NAME,
        defaultMode: 0o444,
      },
    },
    {
      name: "ledger",
      ...(profile.kind === "local"
        ? {
            hostPath: {
              path: `${GKE_ARTIFACT_MOUNT_PATH}/${input.namespace}/ledger`,
              type: "DirectoryOrCreate",
            },
          }
        : {
            emptyDir: {},
          }),
    },
    ...(profile.kind === "gke"
      ? [
          {
            name: "artifacts",
            csi: {
              driver: GKE_GCS_FUSE_DRIVER,
              readOnly: false,
              volumeAttributes: {
                bucketName: profile.artifactBucket,
                mountOptions: GKE_GCS_FUSE_MOUNT_OPTIONS,
              },
            },
          },
        ]
      : []),
  ];
}

function ledgerPermissionsContainer(
  input: RunSocietyWorkflowInput,
): V1Container {
  return {
    name: "ledger-permissions",
    image: input.controllerImage,
    command: ["chown"],
    args: [
      `${String(CONTROLLER_USER_ID)}:${String(CONTROLLER_USER_ID)}`,
      LOCAL_LEDGER_DIRECTORY,
    ],
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { add: ["CHOWN"], drop: ["ALL"] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: false,
      runAsUser: 0,
    },
    volumeMounts: [{ name: "ledger", mountPath: LOCAL_LEDGER_DIRECTORY }],
  };
}

/** Cluster-wide identity and workload serving the run-lifecycle task queue. */
export interface RunWorkerManifests {
  readonly namespace: V1Namespace;
  readonly serviceAccount: V1ServiceAccount;
  readonly clusterRole: V1ClusterRole;
  readonly clusterRoleBinding: V1ClusterRoleBinding;
  readonly deployment: V1Deployment;
}

/** Everything the worker needs that the host, not the cluster, decides. */
export interface RunWorkerOptions {
  readonly controllerImage: string;
  readonly taskQueue: string;
  readonly temporalAddress: string;
  readonly temporalNamespace: string;
  readonly profile: KubernetesExecutionProfile;
}

function runWorkerNamespace(): V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: SYSTEM_NAMESPACE,
      labels: { "app.kubernetes.io/managed-by": "moltzap-simulator" },
    },
  };
}

function runWorkerServiceAccount(): V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: RUN_WORKER_NAME,
      namespace: SYSTEM_NAMESPACE,
      labels: runWorkerLabels(),
    },
  };
}

type PolicyRules = NonNullable<V1ClusterRole["rules"]>;

function runWorkerClusterRole(): V1ClusterRole {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name: RUN_WORKER_NAME, labels: runWorkerLabels() },
    rules: [
      ...reclamationRules(),
      ...runPreparationRules(),
      ...delegatedControllerRules(),
    ],
  };
}

// Deleting a namespace is the permission that lets the worker reclaim a run
// whose submitter is gone, which is the reason the worker exists. It cannot be
// narrowed: a run's namespace name is generated at submission, so no name is
// knowable when this role is written, and RBAC has no way to scope a verb by
// label. The breadth is accepted rather than worked around.
function reclamationRules(): PolicyRules {
  return [
    {
      apiGroups: [""],
      resources: ["namespaces"],
      verbs: ["create", "get", "list", "watch", "delete"],
    },
  ];
}

// What preparing one run creates before the controller starts, and what reading
// the controller's outcome needs. Generated namespace names rule out
// `resourceNames` here for the same reason.
function runPreparationRules(): PolicyRules {
  return [
    {
      apiGroups: [""],
      resources: ["configmaps"],
      verbs: ["create", "get", "delete"],
    },
    {
      apiGroups: [""],
      resources: ["serviceaccounts"],
      verbs: ["create"],
    },
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
    { apiGroups: ["batch"], resources: ["jobs"], verbs: ["create", "get"] },
    {
      apiGroups: ["kueue.x-k8s.io"],
      resources: ["localqueues"],
      verbs: ["create"],
    },
    {
      apiGroups: ["rbac.authorization.k8s.io"],
      resources: ["roles", "rolebindings"],
      verbs: ["create"],
    },
  ];
}

// Kubernetes refuses to let a subject create a Role carrying permissions the
// subject does not itself hold, so the run-scoped controller Role is a lower
// bound on what the worker must be granted.
function delegatedControllerRules(): PolicyRules {
  return [
    {
      apiGroups: [""],
      resources: ["secrets", "persistentvolumeclaims", "services"],
      verbs: ["create", "delete"],
    },
    {
      apiGroups: ["apps"],
      resources: ["deployments"],
      verbs: ["create", "delete"],
    },
    {
      apiGroups: ["kueue.x-k8s.io"],
      resources: ["workloads"],
      verbs: ["create", "get", "delete"],
    },
    {
      apiGroups: ["agents.x-k8s.io"],
      resources: ["sandboxes"],
      verbs: ["create", "get", "delete"],
    },
    { apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] },
  ];
}

function runWorkerClusterRoleBinding(): V1ClusterRoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name: RUN_WORKER_NAME, labels: runWorkerLabels() },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: RUN_WORKER_NAME,
    },
    subjects: [
      {
        apiGroup: "",
        kind: "ServiceAccount",
        name: RUN_WORKER_NAME,
        namespace: SYSTEM_NAMESPACE,
      },
    ],
  };
}

function runWorkerDeployment(options: RunWorkerOptions): V1Deployment {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: RUN_WORKER_NAME,
      namespace: SYSTEM_NAMESPACE,
      labels: runWorkerLabels(),
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: runWorkerLabels() },
      template: {
        metadata: { labels: runWorkerLabels() },
        spec: {
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          serviceAccountName: RUN_WORKER_NAME,
          terminationGracePeriodSeconds: RUN_WORKER_TERMINATION_GRACE_SECONDS,
          containers: [runWorkerContainer(options)],
        },
      },
    },
  };
}

function runWorkerContainer(options: RunWorkerOptions): V1Container {
  return {
    name: RUN_WORKER_NAME,
    image: options.controllerImage,
    command: ["node", RUN_WORKER_ENTRYPOINT],
    env: [
      { name: "MOLTZAP_TEMPORAL_ADDRESS", value: options.temporalAddress },
      { name: "MOLTZAP_TEMPORAL_NAMESPACE", value: options.temporalNamespace },
      { name: "MOLTZAP_TEMPORAL_TASK_QUEUE", value: options.taskQueue },
      {
        name: "MOLTZAP_EXECUTION_PROFILE",
        value: encodeKubernetesExecutionProfile(options.profile),
      },
    ],
    readinessProbe: {
      exec: { command: ["/usr/bin/test", "-f", RUN_WORKER_READY_PATH] },
      failureThreshold: 1,
      periodSeconds: 1,
      timeoutSeconds: 1,
    },
    terminationMessagePolicy: "FallbackToLogsOnError",
    resources: { requests: { cpu: "100m", memory: "256Mi" } },
    // A shell sleep rather than the Kubernetes `sleep` handler, which needs a
    // 1.29 control plane; the worker's own image is Debian-based, so `sleep` is
    // there on every cluster this installs into.
    lifecycle: {
      preStop: {
        exec: {
          command: [
            "/bin/sh",
            "-c",
            `sleep ${String(RUN_WORKER_PRESTOP_SECONDS)}`,
          ],
        },
      },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: CONTROLLER_USER_ID,
    },
  };
}

function runWorkerLabels(): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/name": "moltzap-simulator-run-worker",
    "app.kubernetes.io/managed-by": "moltzap-simulator",
  };
}
