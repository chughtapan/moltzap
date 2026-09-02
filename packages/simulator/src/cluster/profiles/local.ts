/** @file The local kind profile's submission, one of the two the executable routes to. */

import { Effect } from "effect";
import {
  type KubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
} from "../profile.js";
import {
  type RunEnvironment,
  runKubernetesSociety,
  type RunSubmission,
  RunSubmissionError,
  type SubmitOperations,
} from "../submit.js";

// safer-arch-ignore no-trivial-sink-file: The local profile stays a module beside the GKE profile so the executable routes to two symmetric, separately tested submitters rather than carrying one of them inline.

type LocalKubernetesExecutionProfile = Extract<
  KubernetesExecutionProfile,
  { readonly kind: "local" }
>;

/**
 * Submit one mounted experiment through the core Kubernetes execution path.
 * @param args One repository-local `.mjs` RunSpec path.
 * @param environment Local profile connection and image configuration.
 * @returns The coarse workflow result and ephemeral run identity.
 */
export function runLocalSociety(
  args: readonly string[],
  environment: RunEnvironment,
): Effect.Effect<RunSubmission, RunSubmissionError, SubmitOperations> {
  return localExecutionProfile(environment).pipe(
    Effect.flatMap((profile) =>
      runKubernetesSociety(args, environment, profile),
    ),
  );
}

function localExecutionProfile(
  environment: RunEnvironment,
): Effect.Effect<LocalKubernetesExecutionProfile, RunSubmissionError> {
  const kubeContext = environment.MOLTZAP_KUBE_CONTEXT;
  if (kubeContext === undefined) {
    return Effect.succeed(LOCAL_KUBERNETES_EXECUTION_PROFILE);
  }
  if (kubeContext.length === 0) {
    return Effect.fail(
      new RunSubmissionError({
        stage: "configuration",
        detail: "MOLTZAP_KUBE_CONTEXT must not be empty when supplied",
      }),
    );
  }
  return Effect.succeed(Object.freeze({ kind: "local", kubeContext }));
}
