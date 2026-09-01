/** @file Private execution profiles for the one Kubernetes simulator path. */

import { Schema } from "effect";

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
  readonly kubeContext?: string;
}

/** GKE-specific host configuration kept outside Temporal workflow input. */
interface GkeKubernetesExecutionProfile {
  readonly kind: "gke";
  readonly artifactBucket: string;
  readonly kubeContext: string;
  readonly rosterPlacement: KubernetesPodPlacement;
}

/** Closed cluster choice for the shared Kubernetes execution path. */
export type KubernetesExecutionProfile =
  | LocalKubernetesExecutionProfile
  | GkeKubernetesExecutionProfile;

/** Default profile preserving the repository-local kind behavior. */
export const LOCAL_KUBERNETES_EXECUTION_PROFILE: LocalKubernetesExecutionProfile =
  Object.freeze({ kind: "local" });

const podPlacementSchema = Schema.Struct({
  nodeSelector: Schema.Record({ key: Schema.String, value: Schema.String }),
  tolerations: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      operator: Schema.Literal("Equal"),
      value: Schema.String,
      effect: Schema.Literal("NoSchedule"),
    }),
  ),
});

const executionProfileSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("local"),
    kubeContext: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("gke"),
    artifactBucket: Schema.String,
    kubeContext: Schema.String,
    rosterPlacement: podPlacementSchema,
  }),
);

const decodeProfile = Schema.decodeUnknownSync(
  Schema.parseJson(executionProfileSchema),
);

/**
 * Encode the host's cluster choice for a process that cannot be given it
 * as an argument.
 * @param profile Host-selected local or GKE cluster.
 * @returns The JSON form carried in an in-cluster process environment.
 */
export function encodeKubernetesExecutionProfile(
  profile: KubernetesExecutionProfile,
): string {
  return JSON.stringify(profile);
}

/**
 * Read back the profile an in-cluster process was started with.
 * @param source JSON produced by `encodeKubernetesExecutionProfile`.
 * @returns The closed cluster choice, or a throw naming the mismatch.
 */
export function decodeKubernetesExecutionProfile(
  source: string,
): KubernetesExecutionProfile {
  return decodeProfile(source);
}
