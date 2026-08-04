/** @file Temporal activities for one run-scoped Kubernetes controller. */

import type {
  CleanupRunInput,
  RunControllerResult,
  RunLifecycleActivities,
  RunSocietyWorkflowInput,
} from "./contract.js";
import {
  LOCAL_KUBERNETES_EXECUTION_PROFILE,
  type KubernetesExecutionProfile,
} from "../kubernetes/profile.js";
import { makeKubernetesRunLifecycleOperations } from "./kubernetes.js";

/** Coarse controller state observed by the host-side activity. */
export type ControllerObservation =
  | { readonly _tag: "running" }
  | {
      readonly _tag: "succeeded";
      readonly result: RunControllerResult;
    }
  | {
      readonly _tag: "failed";
      readonly detail: string;
      readonly result?: RunControllerResult;
    };

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Temporal activities and their host-operation dependencies are SDK-required Promise boundaries. */

/** Injectable host operations kept outside deterministic workflow code. */
export interface RunLifecycleOperations {
  readonly prepareRun: (input: RunSocietyWorkflowInput) => Promise<void>;
  readonly observeController: (
    input: RunSocietyWorkflowInput,
  ) => Promise<ControllerObservation>;
  readonly deleteRunNamespace: (namespace: string) => Promise<void>;
  readonly runNamespaceExists: (namespace: string) => Promise<boolean>;
  readonly waitBeforeObservation: () => Promise<void>;
}

class ControllerAttemptFailed extends Error {
  override readonly name = "ControllerAttemptFailed";
}

async function runControllerOnce(
  operations: RunLifecycleOperations,
  input: RunSocietyWorkflowInput,
): Promise<RunControllerResult> {
  await operations.prepareRun(input);
  for (;;) {
    const observation = await operations.observeController(input);
    switch (observation._tag) {
      case "succeeded":
        return observation.result;
      case "failed":
        if (observation.result !== undefined) {
          return observation.result;
        }
        throw new ControllerAttemptFailed(observation.detail);
      case "running":
        await operations.waitBeforeObservation();
        break;
      default:
        throw new ControllerAttemptFailed(
          "controller returned an unsupported observation",
        );
    }
  }
}

async function cleanupRun(
  operations: RunLifecycleOperations,
  input: CleanupRunInput,
): Promise<void> {
  await operations.deleteRunNamespace(input.namespace);
  while (await operations.runNamespaceExists(input.namespace)) {
    await operations.waitBeforeObservation();
  }
}

/**
 * Build activity implementations around injectable Kubernetes operations.
 * @param operations Host operations used by the Promise-native activity boundary.
 * @returns The two activities registered by the coarse workflow worker.
 */
export function makeRunLifecycleActivitiesWith(
  operations: RunLifecycleOperations,
): RunLifecycleActivities {
  return Object.freeze({
    runControllerOnce: (input: RunSocietyWorkflowInput) =>
      runControllerOnce(operations, input),
    cleanupRun: (input: CleanupRunInput) => cleanupRun(operations, input),
  });
}

/**
 * Build live activities from the host's default Kubernetes configuration.
 * @param profile Private local or GKE infrastructure selected by the host.
 * @returns Activities backed by the selected local or cluster kubeconfig.
 */
export function makeKubernetesRunLifecycleActivities(
  profile: KubernetesExecutionProfile = LOCAL_KUBERNETES_EXECUTION_PROFILE,
): RunLifecycleActivities {
  return makeRunLifecycleActivitiesWith(
    makeKubernetesRunLifecycleOperations(profile),
  );
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Temporal activity boundary. */
