/** @file Stand up one run: its root, its access, its endpoint, its controller. */
// safer-arch-ignore no-trivial-sink-file: Standing a run up is its own step of a run's life; folding it into the module that watches the controller would put two behaviors behind one name.

import { Effect } from "effect";
import type {
  KubernetesCallFailed,
  RunControlApi,
} from "./kubernetes/calls.js";
import { ownedRunControlManifests } from "./kubernetes/objects.js";
import type { KubernetesExecutionProfile } from "./profile.js";
import type { RunSocietyWorkflowInput } from "./reclaim.js";

/**
 * Create everything one run needs before its controller starts, in order.
 *
 * The order is the contract. The run root's UID owns every object created after
 * it, so nothing can be built until it exists. The controller Job is created
 * last because it immediately acts through the run-scoped RBAC and dials the
 * router Service by name: started any earlier, it races objects it depends on.
 *
 * @param api Kubernetes access held by the worker running this activity.
 * @param input Serializable run identity, images, and experiment module.
 * @param profile Private local or GKE storage and placement projection.
 * @returns Nothing once the controller Job has been created.
 * @failure KubernetesCallFailed when any object could not be created.
 */
export function prepareRun(
  api: RunControlApi,
  input: RunSocietyWorkflowInput,
  profile: KubernetesExecutionProfile,
): Effect.Effect<void, KubernetesCallFailed> {
  return Effect.gen(function* () {
    const ownerUid = yield* api.createRunRoot(input);
    const manifests = ownedRunControlManifests(input, ownerUid, profile);
    yield* api.createExperimentAndQueue(input.namespace, manifests);
    yield* api.createControllerAccess(input.namespace, manifests);
    yield* api.createRouterService(input.namespace, manifests);
    yield* api.startController(input.namespace, manifests);
  }).pipe(Effect.withSpan("prepareRun"));
}
