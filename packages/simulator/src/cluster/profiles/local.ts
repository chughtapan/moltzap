/** @file Repository-local profile entry point for one Temporal-managed run. */

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { isEntryModule } from "../entry.js";
import { LOCAL_KUBERNETES_EXECUTION_PROFILE } from "../profile.js";
import {
  liveSubmitOperations,
  runKubernetesSociety,
  type RunEnvironment,
  type RunSubmission,
  type RunSubmissionError,
  type SubmitOperations,
} from "../submit.js";

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
  return runKubernetesSociety(
    args,
    environment,
    LOCAL_KUBERNETES_EXECUTION_PROFILE,
  );
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
