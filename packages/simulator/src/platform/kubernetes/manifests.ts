/** @file Private manifests for aggregate admission and run-owned resources. */

import { SimulatorInfrastructureFailure } from "../failure.js";
import type {
  DistributedApplicationContainer,
  DistributedContainerImage,
} from "../../runtime/distributed.js";
import type { KubernetesManifest } from "./api.js";
import type { KubernetesPodPlacement } from "./profile.js";

const MAX_KUEUE_POD_SETS = 8;
const BOOTSTRAP_INPUT_PATH = "/var/run/moltzap/secret";
const BOOTSTRAP_OUTPUT_PATH = "/var/run/moltzap/bootstrap";
const RUNTIME_STATE_PATH = "/var/lib/moltzap";

/** Run root created by the Temporal activity before the controller starts. */
export interface KubernetesRunOwner {
  readonly name: string;
  readonly uid: string;
}

/** Capacity facts projected from one private distributed runtime. */
export interface RuntimeCapacitySlot {
  readonly image: string;
  readonly requests: Readonly<Record<string, string>>;
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
  readonly supportImage: DistributedContainerImage;
  readonly application: DistributedApplicationContainer;
  readonly credentialSecretKeys: Readonly<
    Record<"ANTHROPIC_API_KEY" | "OPENAI_API_KEY", string | undefined>
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
    throw new SimulatorInfrastructureFailure({
      detail: "aggregate capacity reservation requires at least one runtime",
    });
  }
  if (groups.length > MAX_KUEUE_POD_SETS) {
    throw new SimulatorInfrastructureFailure({
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
  resources: DistributedApplicationContainer["resources"],
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
    command: ["node", "/opt/moltzap/dist/platform/kubernetes/bootstrap.js"],
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
  const credentials = (input.application.credentialEnvironment ?? [])
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
    ports: input.application.ports.map((containerPort) => ({
      name: `gateway-${String(containerPort)}`,
      containerPort,
      protocol: "TCP",
    })),
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
