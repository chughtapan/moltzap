import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { KubernetesExecutionProfile } from "../kubernetes/profile.js";
import type { RunSocietyWorkflowInput } from "./contract.js";
import {
  CLUSTER_QUEUE_NAME,
  CONTROLLER_NAME,
  EXPERIMENT_CONFIG_NAME,
  LOCAL_QUEUE_NAME,
  ownedRunControlManifests,
  ROUTER_SERVICE_NAME,
  RUN_OWNER_NAME,
  runNamespaceManifest,
  runOwnerManifest,
} from "./manifests.js";

const DIGEST = "a".repeat(64);
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

// eslint-disable-next-line agent-code-guard/no-example-only-tests -- These regression tests pin exact third-party Kubernetes manifest contracts.
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
    command: ["node", "/opt/moltzap/dist/platform/controller/main.js"],
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
