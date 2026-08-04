/** @file Run-scoped control objects created by the Temporal activity. */

import type {
  V1ConfigMap,
  V1Container,
  V1Job,
  V1Namespace,
  V1OwnerReference,
  V1Role,
  V1RoleBinding,
  V1Service,
  V1ServiceAccount,
  V1Volume,
} from "@kubernetes/client-node";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "../kubernetes/profile.js";
import type { RunSocietyWorkflowInput } from "./contract.js";

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

const CONTROLLER_PORT = 3_000;
const CONTROLLER_ENTRYPOINT = "/opt/moltzap/dist/platform/controller/main.js";
const EXPERIMENT_DIRECTORY = "/opt/moltzap/experiment";
const EXPERIMENT_PATH = `${EXPERIMENT_DIRECTORY}/main.mjs`;
const LOCAL_LEDGER_DIRECTORY = "/var/lib/moltzap/ledger";
const CONTROLLER_USER_ID = 1_000;
const GKE_GCS_FUSE_ANNOTATION = "gke-gcsfuse/volumes";
const GKE_GCS_FUSE_DRIVER = "gcsfuse.csi.storage.gke.io";
const GKE_GCS_FUSE_MOUNT_OPTIONS =
  "uid=1000,gid=1000,file-mode=0640,dir-mode=0750";
const GKE_ARTIFACT_MOUNT_PATH = "/var/lib/moltzap-artifacts";

type KubernetesCustomManifest = Readonly<Record<string, unknown>>;

/** Objects created after the run root establishes owner identity. */
export interface OwnedRunControlManifests {
  readonly experiment: V1ConfigMap;
  readonly localQueue: KubernetesCustomManifest;
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

function ownerReference(uid: string): V1OwnerReference {
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
 * @returns A Namespace manifest owned by the surrounding infrastructure authority.
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
): KubernetesCustomManifest {
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
  const owner = ownerReference(ownerUid);
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
