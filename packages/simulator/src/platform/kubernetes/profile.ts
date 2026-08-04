/** @file Private execution profiles for the one Kubernetes simulator path. */

/** Placement projected onto both reserved capacity and actual application Pods. */
export interface KubernetesPodPlacement {
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly tolerations: ReadonlyArray<{
    readonly key: string;
    readonly operator: "Equal";
    readonly value: string;
    readonly effect: "NoSchedule";
  }>;
}

/** Host-mounted artifact storage used by the repository's kind profile. */
interface LocalKubernetesExecutionProfile {
  readonly kind: "local";
}

/** GKE-specific host configuration kept outside Temporal workflow input. */
interface GkeKubernetesExecutionProfile {
  readonly kind: "gke";
  readonly artifactBucket: string;
  readonly kubeContext: string;
  readonly rosterPlacement: KubernetesPodPlacement;
}

/** Closed infrastructure choice for the shared Kubernetes execution path. */
export type KubernetesExecutionProfile =
  | LocalKubernetesExecutionProfile
  | GkeKubernetesExecutionProfile;

/** Default profile preserving the repository-local kind behavior. */
export const LOCAL_KUBERNETES_EXECUTION_PROFILE: LocalKubernetesExecutionProfile =
  Object.freeze({ kind: "local" });
