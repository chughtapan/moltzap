/** @file Kubernetes objects for one run-private Registry and Router. */

import type {
  V1Deployment,
  V1PersistentVolumeClaim,
  V1Service,
} from "@kubernetes/client-node";
import type { Image } from "../../agents/index.js";
import type { KubernetesManifest } from "./calls.js";
import {
  ADMISSION_CREDENTIAL_SECRET_KEY,
  REGISTRY_PORT,
  REGISTRY_PRIVATE_KEY_SECRET_KEY,
  REGISTRY_SERVICE_NAME,
  ROUTER_PORT,
  ROUTER_SERVICE_NAME,
  type SocietyNetworkAuthority,
} from "../society-network.js";
import { bootstrapSecretManifest, type KubernetesRunOwner } from "./objects.js";

const REGISTRY_STATE_PATH = "/var/lib/moltzap/registry";
const REGISTRY_SECRET_PATH = "/var/run/moltzap/registry";
const STATE_STORAGE = "1Gi";

/** Fixed run-owned objects that host the one Registry and one Router. */
export interface SocietyNetworkManifests {
  readonly secret: KubernetesManifest;
  readonly registryState: V1PersistentVolumeClaim;
  readonly registryService: V1Service;
  readonly registryDeployment: V1Deployment;
  readonly routerService: V1Service;
  readonly routerDeployment: V1Deployment;
}

interface SocietyNetworkManifestInput {
  readonly namespace: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly owner: KubernetesRunOwner;
  readonly supportImage: Image;
  readonly authority: SocietyNetworkAuthority;
}

interface EndpointStateClaimInput {
  readonly namespace: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly owner: KubernetesRunOwner;
}

/** Run-private Secret shared only by Registry and endpoint daemons. */
export const SOCIETY_NETWORK_SECRET_NAME = "society-network";
/** Persistent state claim for the run Registry's private database. */
export const REGISTRY_STATE_CLAIM_NAME = "registry-state";

/**
 * Build the complete run-owned production Identity and Router stack.
 * @param input Run identity, owner, support image, labels, and network authority.
 * @returns The complete set of run-owned network manifests.
 */
export function societyNetworkManifests(
  input: SocietyNetworkManifestInput,
): SocietyNetworkManifests {
  const registryState = endpointStateClaimManifest({
    namespace: input.namespace,
    name: REGISTRY_STATE_CLAIM_NAME,
    labels: networkLabels(input, "registry"),
    owner: input.owner,
  });
  return {
    secret: bootstrapSecretManifest({
      namespace: input.namespace,
      name: SOCIETY_NETWORK_SECRET_NAME,
      labels: input.labels,
      owner: input.owner,
      data: {
        [REGISTRY_PRIVATE_KEY_SECRET_KEY]:
          input.authority.registryPrivateKeyPem,
        [ADMISSION_CREDENTIAL_SECRET_KEY]: input.authority.admissionCredential,
      },
    }),
    registryState,
    registryService: networkService(input, "registry", REGISTRY_PORT),
    registryDeployment: registryDeployment(input),
    routerService: networkService(input, "router", ROUTER_PORT),
    routerDeployment: routerDeployment(input),
  };
}

/**
 * Build one run-owned persistent state claim used by endpoint processes.
 * @param input Run identity, owner, labels, and claim name.
 * @returns The run-owned persistent state claim.
 */
export function endpointStateClaimManifest(
  input: EndpointStateClaimInput,
): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: input.labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: STATE_STORAGE } },
    },
  };
}

function networkService(
  input: SocietyNetworkManifestInput,
  component: "registry" | "router",
  port: number,
): V1Service {
  const labels = networkLabels(input, component);
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name:
        component === "registry" ? REGISTRY_SERVICE_NAME : ROUTER_SERVICE_NAME,
      namespace: input.namespace,
      labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      selector: labels,
      ports: [{ name: "http", port, targetPort: port, protocol: "TCP" }],
    },
  };
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- Keeping the Registry and its colocated database in one literal makes their shared state, probes, and secret mounts reviewable together.
function registryDeployment(input: SocietyNetworkManifestInput): V1Deployment {
  const labels = networkLabels(input, "registry");
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: REGISTRY_SERVICE_NAME,
      namespace: input.namespace,
      labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers: [
            {
              name: "postgresql",
              image: input.supportImage,
              command: ["/srv/moltzap/node_modules/.bin/pglite-server"],
              args: [
                "--db",
                REGISTRY_STATE_PATH,
                "--host",
                "127.0.0.1",
                "--port",
                "5432",
                "--max-connections",
                "10",
              ],
              ports: [{ name: "postgresql", containerPort: 5432 }],
              readinessProbe: { tcpSocket: { port: 5432 }, periodSeconds: 1 },
              resources: { requests: { cpu: "100m", memory: "256Mi" } },
              volumeMounts: [
                { name: "registry-state", mountPath: REGISTRY_STATE_PATH },
              ],
            },
            {
              name: "registry",
              image: input.supportImage,
              command: ["/srv/moltzap/node_modules/.bin/moltzap-registry"],
              env: [
                { name: "MOLTZAP_REGISTRY_HOST", value: "0.0.0.0" },
                { name: "MOLTZAP_REGISTRY_PORT", value: String(REGISTRY_PORT) },
                {
                  name: "MOLTZAP_REGISTRY_POSTGRESQL_URL",
                  value:
                    "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
                },
                {
                  name: "MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL",
                  valueFrom: {
                    secretKeyRef: {
                      name: SOCIETY_NETWORK_SECRET_NAME,
                      key: ADMISSION_CREDENTIAL_SECRET_KEY,
                    },
                  },
                },
                {
                  name: "MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH",
                  value: `${REGISTRY_SECRET_PATH}/${REGISTRY_PRIVATE_KEY_SECRET_KEY}`,
                },
              ],
              ports: [{ name: "http", containerPort: REGISTRY_PORT }],
              startupProbe: {
                tcpSocket: { port: REGISTRY_PORT },
                failureThreshold: 120,
                periodSeconds: 1,
              },
              readinessProbe: {
                tcpSocket: { port: REGISTRY_PORT },
                periodSeconds: 1,
              },
              resources: { requests: { cpu: "100m", memory: "256Mi" } },
              volumeMounts: [
                {
                  name: "registry-secret",
                  mountPath: REGISTRY_SECRET_PATH,
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "registry-state",
              persistentVolumeClaim: { claimName: REGISTRY_STATE_CLAIM_NAME },
            },
            {
              name: "registry-secret",
              secret: {
                secretName: SOCIETY_NETWORK_SECRET_NAME,
                items: [
                  {
                    key: REGISTRY_PRIVATE_KEY_SECRET_KEY,
                    path: REGISTRY_PRIVATE_KEY_SECRET_KEY,
                    mode: 0o440,
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The complete Router Pod contract is a single declarative Kubernetes literal.
function routerDeployment(input: SocietyNetworkManifestInput): V1Deployment {
  const labels = networkLabels(input, "router");
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: ROUTER_SERVICE_NAME,
      namespace: input.namespace,
      labels,
      ownerReferences: [ownerReference(input.owner)],
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000 },
          containers: [
            {
              name: "router",
              image: input.supportImage,
              command: ["/srv/moltzap/node_modules/.bin/moltzap-router"],
              env: [
                { name: "MOLTZAP_ROUTER_HOST", value: "0.0.0.0" },
                { name: "MOLTZAP_ROUTER_PORT", value: String(ROUTER_PORT) },
                {
                  name: "MOLTZAP_ROUTER_REGISTRY_ORIGIN",
                  value: input.authority.registryOrigin,
                },
                {
                  name: "MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY",
                  value: input.authority.registrySignerPublicKeyJson,
                },
              ],
              ports: [{ name: "http", containerPort: ROUTER_PORT }],
              startupProbe: {
                tcpSocket: { port: ROUTER_PORT },
                failureThreshold: 120,
                periodSeconds: 1,
              },
              readinessProbe: {
                tcpSocket: { port: ROUTER_PORT },
                periodSeconds: 1,
              },
              resources: { requests: { cpu: "100m", memory: "256Mi" } },
            },
          ],
        },
      },
    },
  };
}

function networkLabels(
  input: SocietyNetworkManifestInput,
  component: "registry" | "router",
) {
  return {
    ...input.labels,
    "app.kubernetes.io/name": `moltzap-${component}`,
    "app.kubernetes.io/component": component,
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
