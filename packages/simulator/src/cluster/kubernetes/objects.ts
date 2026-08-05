// safer-arch-ignore no-cross-domain-sibling-import: Kubernetes objects carry the agent, ledger, and router identities the run gives them.
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
import { ClusterError } from "../cluster.js";
import type {
  CredentialName,
  Image,
  Resources,
} from "../../agents/container.js";
import type { KubernetesManifest } from "./calls.js";
import {
  encodeKubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
  type KubernetesPodPlacement,
} from "../profile.js";
import type { RunSocietyWorkflowInput } from "../reclaim.js";

const MAX_KUEUE_POD_SETS = 8;
const BOOTSTRAP_INPUT_PATH = "/var/run/moltzap/secret";
const BOOTSTRAP_OUTPUT_PATH = "/var/run/moltzap/bootstrap";
const RUNTIME_STATE_PATH = "/var/lib/moltzap";

/** Run root created by the Temporal activity before the controller starts. */
export interface KubernetesRunOwner {
  readonly name: string;
  readonly uid: string;
}

/** Capacity facts projected from one private container runtime. */
export interface RuntimeCapacitySlot {
  readonly image: string;
  readonly requests: Readonly<Record<string, string>>;
}

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
  readonly slots: readonly RuntimeCapacitySlot[];
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
  readonly application: SandboxApplication;
  readonly credentialSecretKeys: Readonly<
    Record<CredentialName, string | undefined>
  >;
  readonly placement?: KubernetesPodPlacement;
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

function capacityKey(slot: RuntimeCapacitySlot): string {
  return JSON.stringify(
    Object.entries(slot.requests).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
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

/**
 * Build one immutable Kueue Workload for the complete roster.
 * @param input Run-scoped identity, queue, and credential-free capacity facts.
 * @returns Strict custom-resource manifest submitted to Kueue.
 */
export function aggregateWorkloadManifest(
  input: AggregateWorkloadInput,
): KubernetesManifest {
  const groups = groupCapacity(input.slots);
  if (groups.length === 0) {
    throw new ClusterError({
      detail: "aggregate capacity reservation requires at least one runtime",
    });
  }
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

function resourceRequests(
  resources: Resources,
): Readonly<Record<string, string>> {
  return {
    cpu: `${String(resources.cpuMillis)}m`,
    memory: String(resources.memoryBytes),
    "ephemeral-storage": String(resources.ephemeralStorageBytes),
  };
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
      "--overlay",
      "/opt/moltzap/application-overlay",
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
  return {
    name: "application",
    image: input.application.image,
    command: [command],
    args,
    env: [
      ...Object.entries(input.application.environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ({ name, value })),
      ...credentials,
    ],
    ports: [
      {
        name: `gateway-${String(input.application.port)}`,
        containerPort: input.application.port,
        protocol: "TCP",
      },
    ],
    resources: { requests: resourceRequests(input.application.resources) },
    volumeMounts: [
      { name: "bootstrap-output", mountPath: BOOTSTRAP_OUTPUT_PATH },
      { name: "runtime-state", mountPath: RUNTIME_STATE_PATH },
    ],
  };
}

function sandboxPodSpec(input: SandboxManifestInput) {
  return {
    ...podPlacement(input.placement),
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    restartPolicy: "Never",
    securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    initContainers: [bootstrapContainer(input)],
    containers: [applicationContainer(input)],
    volumes: [
      {
        name: "bootstrap-input",
        secret: { secretName: input.bootstrapSecretName },
      },
      { name: "bootstrap-output", emptyDir: {} },
      { name: "runtime-state", emptyDir: {} },
    ],
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

/** Root ConfigMap name shared with controller-created owner references. */
export const RUN_OWNER_NAME = "run";
/** ConfigMap containing the mounted experiment module. */
export const EXPERIMENT_CONFIG_NAME = "experiment";
/** Run-local queue consumed by the aggregate Kueue Workload. */
export const LOCAL_QUEUE_NAME = "society";
/** Profile-owned ClusterQueue selected by every run-local queue. */
export const CLUSTER_QUEUE_NAME = "moltzap";
/** Shared ServiceAccount, RBAC, and Job name for the controller. */
export const CONTROLLER_NAME = "controller";
/** Service name exposing the controller-owned router process. */
export const ROUTER_SERVICE_NAME = "router";
/** Namespace holding the cluster's long-lived simulator control plane. */
export const SYSTEM_NAMESPACE = "moltzap-system";
/** ServiceAccount, RBAC, and Deployment name for the run-lifecycle worker. */
export const RUN_WORKER_NAME = "run-worker";
/** Temporal endpoint a Pod in this cluster reaches the local server on. */
export const IN_CLUSTER_TEMPORAL_ADDRESS = `temporal.${SYSTEM_NAMESPACE}.svc.cluster.local:7233`;

const RUN_WORKER_ENTRYPOINT = "/opt/moltzap/dist/cluster/temporal.js";
const CONTROLLER_PORT = 3_000;
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
  readonly routerService: V1Service;
  readonly controllerJob: V1Job;
}

function runAnnotations(runId: string): Readonly<Record<string, string>> {
  return { "moltzap.dev/run-id": runId };
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
    ...(input.runtimeCredentials === undefined
      ? []
      : [
          {
            name: "MOLTZAP_RUNTIME_CREDENTIALS",
            value: JSON.stringify(input.runtimeCredentials),
          },
        ]),
    { name: "MOLTZAP_EXPERIMENT_MODULE", value: EXPERIMENT_PATH },
    { name: "MOLTZAP_LEDGER_DIRECTORY", value: LOCAL_LEDGER_DIRECTORY },
    ...(profile.kind === "gke"
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
      : []),
    {
      name: "MOLTZAP_ROUTER_URL",
      value: `ws://${ROUTER_SERVICE_NAME}.${input.namespace}.svc.cluster.local:${String(CONTROLLER_PORT)}`,
    },
  ];
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
        resources: ["secrets"],
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

function routerService(
  input: RunSocietyWorkflowInput,
  owner: V1OwnerReference,
): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: ROUTER_SERVICE_NAME,
      namespace: input.namespace,
      ownerReferences: [owner],
    },
    spec: {
      selector: controllerLabels(),
      ports: [
        {
          name: "router",
          port: CONTROLLER_PORT,
          protocol: "TCP",
          targetPort: CONTROLLER_PORT,
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
    env: controllerEnvironment(input, owner.uid, profile),
    ports: [
      {
        name: "router",
        containerPort: CONTROLLER_PORT,
        protocol: "TCP",
      },
    ],
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
    routerService: routerService(input, owner),
    controllerJob: controllerJob(input, owner, profile),
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

function runWorkerLabels(): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/name": "moltzap-simulator-run-worker",
    "app.kubernetes.io/managed-by": "moltzap-simulator",
  };
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
      resources: ["serviceaccounts", "services"],
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
    { apiGroups: [""], resources: ["secrets"], verbs: ["create", "delete"] },
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
  ];
}

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
    terminationMessagePolicy: "FallbackToLogsOnError",
    resources: { requests: { cpu: "100m", memory: "256Mi" } },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      runAsUser: CONTROLLER_USER_ID,
    },
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
      selector: { matchLabels: runWorkerLabels() },
      template: {
        metadata: { labels: runWorkerLabels() },
        spec: {
          automountServiceAccountToken: true,
          enableServiceLinks: false,
          serviceAccountName: RUN_WORKER_NAME,
          containers: [runWorkerContainer(options)],
        },
      },
    },
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
