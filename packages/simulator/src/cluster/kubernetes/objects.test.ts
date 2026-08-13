import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { image } from "../../agents/container.js";
import type { KubernetesExecutionProfile } from "../profile.js";
import type { RunSocietyWorkflowInput } from "../reclaim.js";
import {
  aggregateWorkloadManifest,
  bootstrapSecretManifest,
  CLUSTER_QUEUE_NAME,
  CONTROLLER_NAME,
  EXPERIMENT_CONFIG_NAME,
  IN_CLUSTER_TEMPORAL_ADDRESS,
  LOCAL_QUEUE_NAME,
  ownedRunControlManifests,
  ROUTER_SERVICE_NAME,
  RUN_OWNER_NAME,
  RUN_WORKER_NAME,
  RUN_WORKER_PRESTOP_SECONDS,
  RUN_WORKER_TERMINATION_GRACE_SECONDS,
  runNamespaceManifest,
  runOwnerManifest,
  runWorkerManifests,
  sandboxManifest,
  SYSTEM_NAMESPACE,
} from "./objects.js";

const OWNER = { name: "run", uid: "run-uid" };
const SUPPORT_IMAGE = image.make(`registry/simulator@sha256:${"c".repeat(64)}`);
const APPLICATION_IMAGE = image.make(
  `registry/openclaw@sha256:${"d".repeat(64)}`,
);
const SECRET_CONTENT = "secret-content";
const PARTIAL_ADMISSION_FIELD = "minCount";
const PLACEMENT = {
  nodeSelector: { "moltzap.dev/pool": "agents" },
  tolerations: [
    {
      key: "moltzap.dev/agents",
      operator: "Equal" as const,
      value: "true",
      effect: "NoSchedule" as const,
    },
  ],
};

function aggregateManifest(withPlacement = false) {
  return aggregateWorkloadManifest({
    namespace: "mz-run",
    name: "society",
    queueName: "simulator",
    labels: { "moltzap.dev/run": "run-1" },
    owner: OWNER,
    ...(withPlacement ? { placement: PLACEMENT } : {}),
    slots: [
      {
        image: "registry/openclaw@sha256:abc",
        requests: { cpu: "1", memory: "1Gi" },
      },
      {
        image: "registry/openclaw@sha256:def",
        requests: { memory: "1Gi", cpu: "1" },
      },
    ],
  });
}

function sandboxFixture(withPlacement = false) {
  return sandboxManifest({
    namespace: "mz-run",
    name: "agent-1-alice",
    labels: { "moltzap.dev/run": "run-1" },
    owner: OWNER,
    bootstrapSecretName: "agent-1-alice-bootstrap",
    supportImage: SUPPORT_IMAGE,
    ...(withPlacement ? { placement: PLACEMENT } : {}),
    application: {
      image: APPLICATION_IMAGE,
      entrypoint: ["openclaw", "gateway", "run"],
      environment: { HOME: "/var/lib/moltzap/openclaw" },
      credentials: ["OPENAI_API_KEY"],
      port: 18_789,
      resources: {
        cpuMillis: 2_000,
        memoryBytes: 2_147_483_648,
        ephemeralStorageBytes: 2_147_483_648,
      },
    },
    credentialSecretKeys: {
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: "credential-OPENAI_API_KEY",
    },
  });
}

// eslint-disable-next-line agent-code-guard/no-example-only-tests -- these examples pin exact third-party manifest schemas and ordering omissions
it("reserves identical runtimes as one all-or-nothing pod set", () => {
  const manifest = aggregateManifest();
  expect(manifest).toMatchObject({
    apiVersion: "kueue.x-k8s.io/v1beta2",
    kind: "Workload",
    spec: {
      active: true,
      queueName: "simulator",
      podSets: [
        {
          count: 2,
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [
                {
                  name: "application",
                  resources: { requests: { cpu: "1", memory: "1Gi" } },
                },
              ],
            },
          },
        },
      ],
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(PARTIAL_ADMISSION_FIELD);
});

it("stores bootstrap content as immutable Secret data", () => {
  const manifest = bootstrapSecretManifest({
    namespace: "mz-run",
    name: "alice-bootstrap",
    labels: {},
    owner: OWNER,
    data: { "bootstrap.json": SECRET_CONTENT },
  });
  expect(manifest).toMatchObject({
    apiVersion: "v1",
    kind: "Secret",
    immutable: true,
    data: {
      "bootstrap.json": Buffer.from(SECRET_CONTENT).toString("base64"),
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(SECRET_CONTENT);
});

it("creates one application container without bootstrap bytes in its environment", () => {
  const manifest = sandboxFixture();
  expect(manifest).toMatchObject({
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    spec: {
      service: true,
      podTemplate: {
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          initContainers: [{ name: "bootstrap", image: SUPPORT_IMAGE }],
          containers: [
            {
              name: "application",
              image: APPLICATION_IMAGE,
              command: ["openclaw"],
              args: ["gateway", "run"],
              env: [
                { name: "HOME", value: "/var/lib/moltzap/openclaw" },
                {
                  name: "OPENAI_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: "agent-1-alice-bootstrap",
                      key: "credential-OPENAI_API_KEY",
                      optional: false,
                    },
                  },
                },
              ],
              ports: [{ containerPort: 18_789, protocol: "TCP" }],
              resources: {
                requests: {
                  cpu: "2000m",
                  memory: "2147483648",
                  "ephemeral-storage": "2147483648",
                },
              },
            },
          ],
        },
      },
    },
  });
  expect(JSON.stringify(manifest)).not.toContain(SECRET_CONTENT);
});

it("projects identical GKE placement onto reserved and actual Pods", () => {
  const workload = aggregateManifest(true);
  const sandbox = sandboxFixture(true);

  expect(workload).toMatchObject({
    spec: { podSets: [{ template: { spec: PLACEMENT } }] },
  });
  expect(sandbox).toMatchObject({
    spec: { podTemplate: { spec: PLACEMENT } },
  });
});

const DIGEST = "a".repeat(64);
const STARTUP_TIMEOUT_VARIABLE = "MOLTZAP_STARTUP_TIMEOUT_MS";
const COHORT_SIZE_VARIABLE = "MOLTZAP_COHORT_SIZE";
const COHORT_SIZE = 100;
const STARTUP_TIMEOUT_MS = 900_000;
const EXPERIMENT_SOURCE = "export const runSpec = society;";
const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: `registry/controller@sha256:${DIGEST}`,
  supportImage: `registry/support@sha256:${DIGEST}`,
  experimentModule: EXPERIMENT_SOURCE,
};
type GkeKubernetesExecutionProfile = Extract<
  KubernetesExecutionProfile,
  { readonly kind: "gke" }
>;
const GKE_PROFILE: GkeKubernetesExecutionProfile = {
  kind: "gke",
  artifactBucket: "moltzap-artifacts-test",
  kubeContext: "gke-test",
  rosterPlacement: {
    nodeSelector: { "moltzap.dev/pool": "agents" },
    tolerations: [
      {
        key: "moltzap.dev/agents",
        operator: "Equal",
        value: "true",
        effect: "NoSchedule",
      },
    ],
  },
};

it("isolates the run and establishes one immutable owner", () => {
  expect(runNamespaceManifest(INPUT)).toMatchObject({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: INPUT.namespace,
      annotations: { "moltzap.dev/run-id": INPUT.runId },
    },
  });
  expect(runOwnerManifest(INPUT)).toMatchObject({
    apiVersion: "v1",
    kind: "ConfigMap",
    immutable: true,
    metadata: { name: RUN_OWNER_NAME, namespace: INPUT.namespace },
  });
});

it("mounts the supplied module and points the local queue at the profile queue", () => {
  const manifests = ownedRunControlManifests(INPUT, "owner-uid");
  expect(manifests.experiment).toMatchObject({
    immutable: true,
    metadata: {
      name: EXPERIMENT_CONFIG_NAME,
      ownerReferences: [{ name: RUN_OWNER_NAME, uid: "owner-uid" }],
    },
    data: { "main.mjs": EXPERIMENT_SOURCE },
  });
  expect(manifests.localQueue).toMatchObject({
    apiVersion: "kueue.x-k8s.io/v1beta2",
    kind: "LocalQueue",
    metadata: { name: LOCAL_QUEUE_NAME, namespace: INPUT.namespace },
    spec: { clusterQueue: CLUSTER_QUEUE_NAME },
  });
});

it("gives the controller only the run-scoped operations its platform uses", () => {
  const { role } = ownedRunControlManifests(INPUT, "owner-uid");
  expect(role.rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        apiGroups: ["kueue.x-k8s.io"],
        resources: ["workloads"],
        verbs: ["create", "get", "delete"],
      }),
      expect.objectContaining({
        apiGroups: ["agents.x-k8s.io"],
        resources: ["sandboxes"],
        verbs: ["create", "get", "delete"],
      }),
      expect.objectContaining({
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: [RUN_OWNER_NAME],
        verbs: ["get", "delete"],
      }),
    ]),
  );
});

it("launches one controller attempt with the closed environment contract", () => {
  const manifests = ownedRunControlManifests(INPUT, "owner-uid");
  const [controller] =
    manifests.controllerJob.spec?.template.spec?.containers ?? [];
  expect(manifests.controllerJob).toMatchObject({
    metadata: { name: CONTROLLER_NAME },
    spec: { backoffLimit: 0 },
  });
  expect(controller).toMatchObject({
    name: CONTROLLER_NAME,
    image: INPUT.controllerImage,
    command: ["node", "/opt/moltzap/dist/cluster/controller/main.js"],
    env: [
      { name: "MOLTZAP_RUN_NAMESPACE", value: INPUT.namespace },
      { name: "MOLTZAP_RUN_QUEUE", value: LOCAL_QUEUE_NAME },
      { name: "MOLTZAP_RUN_OWNER_NAME", value: RUN_OWNER_NAME },
      { name: "MOLTZAP_RUN_OWNER_UID", value: "owner-uid" },
      { name: "MOLTZAP_SUPPORT_IMAGE", value: INPUT.supportImage },
      {
        name: "MOLTZAP_EXPERIMENT_MODULE",
        value: "/opt/moltzap/experiment/main.mjs",
      },
      { name: "MOLTZAP_LEDGER_DIRECTORY", value: "/var/lib/moltzap/ledger" },
      {
        name: "MOLTZAP_ROUTER_URL",
        value: `ws://${ROUTER_SERVICE_NAME}.${INPUT.namespace}.svc.cluster.local:3000`,
      },
    ],
  });
});

it("mounts the experiment and durable local ledger beside the router Service", () => {
  const manifests = ownedRunControlManifests(INPUT, "owner-uid");
  const pod = manifests.controllerJob.spec?.template.spec;
  expect(pod).toMatchObject({
    serviceAccountName: CONTROLLER_NAME,
    restartPolicy: "Never",
  });
  expect(pod?.volumes).toContainEqual({
    name: "experiment",
    configMap: { name: EXPERIMENT_CONFIG_NAME, defaultMode: 0o444 },
  });
  expect(pod?.volumes).toContainEqual({
    name: "ledger",
    hostPath: {
      path: `/var/lib/moltzap-artifacts/${INPUT.namespace}/ledger`,
      type: "DirectoryOrCreate",
    },
  });
  expect(pod?.initContainers).toEqual([
    expect.objectContaining({
      name: "ledger-permissions",
      image: INPUT.controllerImage,
      command: ["chown"],
      args: ["1000:1000", "/var/lib/moltzap/ledger"],
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { add: ["CHOWN"], drop: ["ALL"] },
        readOnlyRootFilesystem: true,
        runAsNonRoot: false,
        runAsUser: 0,
      },
      volumeMounts: [{ name: "ledger", mountPath: "/var/lib/moltzap/ledger" }],
    }),
  ]);
  expect(manifests.routerService).toMatchObject({
    metadata: { name: ROUTER_SERVICE_NAME },
    spec: { ports: [{ port: 3_000, targetPort: 3_000 }] },
  });
});

// eslint-disable-next-line complexity -- This regression assertion pins the two-volume GKE projection across optional Kubernetes manifest fields.
it("separates the active POSIX ledger from the retained GKE export", () => {
  const manifests = ownedRunControlManifests(INPUT, "owner-uid", GKE_PROFILE);
  const template = manifests.controllerJob.spec?.template;
  const ledger = template?.spec?.volumes?.find(
    (volume) => volume.name === "ledger",
  );
  const artifacts = template?.spec?.volumes?.find(
    (volume) => volume.name === "artifacts",
  );

  expect(template?.metadata?.annotations).toEqual({
    "gke-gcsfuse/volumes": "true",
  });
  expect(ledger).toEqual({ name: "ledger", emptyDir: {} });
  expect(artifacts).toEqual({
    name: "artifacts",
    csi: {
      driver: "gcsfuse.csi.storage.gke.io",
      readOnly: false,
      volumeAttributes: {
        bucketName: GKE_PROFILE.artifactBucket,
        mountOptions: "uid=1000,gid=1000,file-mode=0640,dir-mode=0750",
      },
    },
  });
});

it("prepares only the active GKE ledger for the non-root controller", () => {
  const { controllerJob } = ownedRunControlManifests(
    INPUT,
    "owner-uid",
    GKE_PROFILE,
  );
  const pod = controllerJob.spec?.template.spec;
  assert(pod !== undefined);
  const [controller] = pod.containers;
  assert(controller !== undefined);
  const ledger = pod.volumes?.find((volume) => volume.name === "ledger");

  expect(pod.initContainers).toEqual([
    expect.objectContaining({
      name: "ledger-permissions",
      volumeMounts: [{ name: "ledger", mountPath: "/var/lib/moltzap/ledger" }],
    }),
  ]);
  expect(ledger?.hostPath).toBeUndefined();
  expect(controller.volumeMounts).toContainEqual({
    name: "ledger",
    mountPath: "/var/lib/moltzap/ledger",
  });
  expect(controller.volumeMounts).toContainEqual({
    name: "artifacts",
    mountPath: "/var/lib/moltzap-artifacts",
  });
});

it("forwards GKE artifact identity and roster placement to the controller", () => {
  const { controllerJob } = ownedRunControlManifests(
    INPUT,
    "owner-uid",
    GKE_PROFILE,
  );
  const pod = controllerJob.spec?.template.spec;
  assert(pod !== undefined);
  const [controller] = pod.containers;
  assert(controller !== undefined);

  expect(controller.env).toContainEqual({
    name: "MOLTZAP_LEDGER_DIRECTORY",
    value: "/var/lib/moltzap/ledger",
  });
  expect(controller.env).toContainEqual({
    name: "MOLTZAP_LEDGER_EXPORT_DIRECTORY",
    value: `/var/lib/moltzap-artifacts/${INPUT.namespace}/ledger`,
  });
  expect(controller.env).toContainEqual({
    name: "MOLTZAP_ROSTER_PLACEMENT",
    value: JSON.stringify(GKE_PROFILE.rosterPlacement),
  });
});

const WORKER_OPTIONS = {
  controllerImage: INPUT.controllerImage,
  taskQueue: "moltzap-simulator",
  temporalAddress: IN_CLUSTER_TEMPORAL_ADDRESS,
  temporalNamespace: "default",
  profile: GKE_PROFILE,
};

it("serves the run queue from a Deployment carrying the host's choices", () => {
  const { deployment, serviceAccount, namespace } =
    runWorkerManifests(WORKER_OPTIONS);
  const [worker] = deployment.spec?.template.spec?.containers ?? [];

  expect(namespace.metadata?.name).toBe(SYSTEM_NAMESPACE);
  expect(serviceAccount.metadata).toMatchObject({
    name: RUN_WORKER_NAME,
    namespace: SYSTEM_NAMESPACE,
  });
  expect(deployment.spec?.template.spec).toMatchObject({
    serviceAccountName: RUN_WORKER_NAME,
  });
  expect(worker).toMatchObject({
    image: INPUT.controllerImage,
    command: ["node", "/opt/moltzap/dist/cluster/temporal.js"],
    env: [
      { name: "MOLTZAP_TEMPORAL_ADDRESS", value: IN_CLUSTER_TEMPORAL_ADDRESS },
      { name: "MOLTZAP_TEMPORAL_NAMESPACE", value: "default" },
      { name: "MOLTZAP_TEMPORAL_TASK_QUEUE", value: "moltzap-simulator" },
      {
        name: "MOLTZAP_EXECUTION_PROFILE",
        value: JSON.stringify(GKE_PROFILE),
      },
    ],
  });
});

// A rolled worker is deleted while it may still be heartbeating a controller
// activity. Delaying the signal is what lets that attempt beat once more, and
// the grace period has to outlast the delay or the kill lands during it.
it("holds the worker's Pod open before signalling it, and longer still after", () => {
  const { deployment } = runWorkerManifests(WORKER_OPTIONS);
  const pod = deployment.spec?.template.spec;
  assert(pod !== undefined);
  const [worker] = pod.containers;
  assert(worker !== undefined);

  expect(worker.lifecycle?.preStop?.exec?.command).toContain(
    `sleep ${String(RUN_WORKER_PRESTOP_SECONDS)}`,
  );
  expect(pod.terminationGracePeriodSeconds).toBe(
    RUN_WORKER_TERMINATION_GRACE_SECONDS,
  );
  expect(RUN_WORKER_PRESTOP_SECONDS).toBeLessThan(
    RUN_WORKER_TERMINATION_GRACE_SECONDS,
  );
});

it("holds cluster-wide namespace deletion and every permission it delegates", () => {
  const { clusterRole, clusterRoleBinding } =
    runWorkerManifests(WORKER_OPTIONS);
  const { role } = ownedRunControlManifests(INPUT, "owner-uid");
  const granted = new Map(
    clusterRole.rules?.map((rule) => [
      `${String(rule.apiGroups)}/${String(rule.resources)}`,
      rule,
    ]),
  );

  expect(clusterRole.rules).toContainEqual({
    apiGroups: [""],
    resources: ["namespaces"],
    verbs: ["create", "get", "list", "watch", "delete"],
  });
  expect(clusterRoleBinding.subjects).toEqual([
    {
      apiGroup: "",
      kind: "ServiceAccount",
      name: RUN_WORKER_NAME,
      namespace: SYSTEM_NAMESPACE,
    },
  ]);
  // Kubernetes rejects a subject that creates a Role carrying verbs the subject
  // does not itself hold, so the run-scoped controller Role is a lower bound on
  // what the worker's ClusterRole must grant.
  for (const rule of role.rules ?? []) {
    const key = `${String(rule.apiGroups)}/${String(rule.resources)}`;
    expect(granted.get(key)?.verbs ?? []).toEqual(
      expect.arrayContaining(rule.verbs),
    );
  }
});

it("scopes nothing by resource name because run namespaces are generated", () => {
  const { clusterRole } = runWorkerManifests(WORKER_OPTIONS);

  expect(
    clusterRole.rules?.filter((rule) => rule.resourceNames !== undefined),
  ).toEqual([]);
});

function controllerEnvironmentOf(
  input: RunSocietyWorkflowInput,
): ReadonlyArray<{ readonly name: string; readonly value?: string }> {
  const manifests = ownedRunControlManifests(input, "owner-uid");
  const [controller] =
    manifests.controllerJob.spec?.template.spec?.containers ?? [];
  return controller?.env ?? [];
}

it("carries a cohort's startup budget into the controller only when one is set", () => {
  const names = controllerEnvironmentOf(INPUT).map((entry) => entry.name);
  expect(names).not.toContain(STARTUP_TIMEOUT_VARIABLE);

  const budgeted = controllerEnvironmentOf({
    ...INPUT,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
  });
  expect(budgeted).toContainEqual({
    name: STARTUP_TIMEOUT_VARIABLE,
    value: String(STARTUP_TIMEOUT_MS),
  });
});

it("carries a run-chosen cohort size into the controller only when one is set", () => {
  const names = controllerEnvironmentOf(INPUT).map((entry) => entry.name);
  expect(names).not.toContain(COHORT_SIZE_VARIABLE);

  const sized = controllerEnvironmentOf({ ...INPUT, cohortSize: COHORT_SIZE });
  expect(sized).toContainEqual({
    name: COHORT_SIZE_VARIABLE,
    value: String(COHORT_SIZE),
  });
});
