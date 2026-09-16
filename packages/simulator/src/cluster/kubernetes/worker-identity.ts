/** @file Give an isolated worker its own workload and Kubernetes access identity. */
import type {
  V1ClusterRole,
  V1ClusterRoleBinding,
  V1Deployment,
  V1Namespace,
  V1ObjectMeta,
  V1ServiceAccount,
} from "@kubernetes/client-node";
import { ClusterError } from "../cluster.js";
interface WorkerObjects {
  namespace: V1Namespace;
  serviceAccount: V1ServiceAccount;
  clusterRole: V1ClusterRole;
  clusterRoleBinding: V1ClusterRoleBinding;
  deployment: V1Deployment;
}
/** Rename access and workload objects together to keep worker Pod selectors isolated. */
export function renameRunWorker<T extends WorkerObjects>(
  objects: T,
  name?: string,
): T {
  if (name === undefined || name === objects.deployment.metadata?.name) {
    return objects;
  }
  validateName(name);
  const labels = Object.assign({}, objects.deployment.metadata?.labels, {
    "app.kubernetes.io/name": name,
  });
  for (const object of [
    objects.serviceAccount,
    objects.clusterRole,
    objects.clusterRoleBinding,
    objects.deployment,
  ]) {
    object.metadata = namedMetadata(name, labels, object.metadata);
  }
  renameAccess(objects, name);
  renamePod(objects.deployment, name, labels);
  return objects;
}
function validateName(name: string) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(name)) {
    throw new ClusterError({ detail: "Invalid run worker name" });
  }
}
function namedMetadata(
  name: string,
  labels: Record<string, string>,
  metadata?: V1ObjectMeta,
) {
  return Object.assign(metadata ?? {}, { name, labels });
}
function renameAccess(objects: WorkerObjects, name: string) {
  const namespace = objects.namespace.metadata?.name;
  if (namespace === undefined) {
    throw new ClusterError({ detail: "Generated worker namespace is missing" });
  }
  objects.clusterRoleBinding.roleRef.name = name;
  objects.clusterRoleBinding.subjects = [
    { apiGroup: "", kind: "ServiceAccount", name, namespace },
  ];
}
function renamePod(
  deployment: V1Deployment,
  name: string,
  labels: Record<string, string>,
) {
  const spec = deployment.spec;
  if (spec?.template.spec === undefined) {
    throw new ClusterError({
      detail: "Generated worker workload is incomplete",
    });
  }
  spec.selector.matchLabels = labels;
  spec.template.metadata = Object.assign(spec.template.metadata ?? {}, {
    labels,
  });
  spec.template.spec.serviceAccountName = name;
}
