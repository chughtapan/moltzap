/** @file Apply isolated worker resources with one field-ownership policy. */
import {
  type AppsV1Api,
  type CoreV1Api,
  PatchStrategy,
  type RbacAuthorizationV1Api,
  setHeaderOptions,
} from "@kubernetes/client-node";
import { ClusterError } from "../cluster.js";
import { type RunWorkerManifests, SYSTEM_NAMESPACE } from "./objects.js";
/** Resource names are derived from the complete worker manifest set. */
export type RunWorkerObject = keyof RunWorkerManifests;
/** Field ownership and strict validation applied to every write. */
export const APPLIED = Object.freeze({
  fieldManager: "moltzap-simulator",
  fieldValidation: "Strict",
} as const);
/** Kubernetes API clients used by worker installation. */
export interface InstallClients {
  readonly apps: AppsV1Api;
  readonly core: CoreV1Api;
  readonly rbac: RbacAuthorizationV1Api;
}

/** One object's apply call, already bound to the manifest it declares. */
export type InstalledObjectApply = () => PromiseLike<unknown>;

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

/** Bind every apply to the same isolated worker name. */
export function installedObjectApplies(
  clients: InstallClients,
  manifests: RunWorkerManifests,
): Readonly<Record<RunWorkerObject, InstalledObjectApply>> {
  const name = workerManifestName(manifests.deployment);
  const namespaced = { name, namespace: SYSTEM_NAMESPACE, ...APPLY };
  return {
    namespace: () =>
      clients.core.patchNamespace(
        { name: SYSTEM_NAMESPACE, body: manifests.namespace, ...APPLY },
        APPLY_OPTIONS,
      ),
    serviceAccount: () =>
      clients.core.patchNamespacedServiceAccount(
        {
          ...namespaced,
          body: manifests.serviceAccount,
        },
        APPLY_OPTIONS,
      ),
    clusterRole: () =>
      clients.rbac.patchClusterRole(
        {
          name,
          body: manifests.clusterRole,
          ...APPLY,
        },
        APPLY_OPTIONS,
      ),
    clusterRoleBinding: () =>
      clients.rbac.patchClusterRoleBinding(
        {
          name,
          body: manifests.clusterRoleBinding,
          ...APPLY,
        },
        APPLY_OPTIONS,
      ),
    deployment: () =>
      clients.apps.patchNamespacedDeployment(
        {
          ...namespaced,
          body: manifests.deployment,
        },
        APPLY_OPTIONS,
      ),
  };
}

/** Missing names must fail before an API call can target another workload. */
export function workerManifestName(object: {
  readonly metadata?: { readonly name?: string };
}): string {
  const name = object.metadata?.name;
  if (name === undefined) {
    throw new ClusterError({
      detail: "Run worker manifest is missing its name",
    });
  }
  return name;
}
