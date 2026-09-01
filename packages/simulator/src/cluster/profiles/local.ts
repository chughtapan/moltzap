/** @file Repository-local profile entry point for one Temporal-managed run. */

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { isEntryModule } from "../entry.js";
import {
  type KubernetesExecutionProfile,
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
} from "../profile.js";
import {
  liveSubmitOperations,
  type RunEnvironment,
  runKubernetesSociety,
  type RunSubmission,
  RunSubmissionError,
  type SubmitOperations,
} from "../submit.js";

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

// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Direct-entry detection has no Effect Platform equivalent.
if (isEntryModule(import.meta.url, process.argv[1])) {
  // eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The executable boundary captures argv once before entering Effect.
  const args = process.argv.slice(2);
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- The executable boundary injects the environment into the typed local configuration.
  const environment = process.env;
  runLocalSociety(args, environment).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }),
    ),
    Effect.provide(liveSubmitOperations),
    NodeRuntime.runMain,
  );
}
