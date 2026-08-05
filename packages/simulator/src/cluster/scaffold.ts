/** @file Stand up one run: its root, its access, its endpoint, its controller. */

import type { RunControlApi } from "./kubernetes/calls.js";
import { ownedRunControlManifests } from "./kubernetes/objects.js";
import type { KubernetesExecutionProfile } from "./profile.js";
import type { RunSocietyWorkflowInput } from "./reclaim.js";

/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The Temporal activity this runs inside is a Promise-native SDK boundary. */

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
 */
export async function prepareRun(
  api: RunControlApi,
  input: RunSocietyWorkflowInput,
  profile: KubernetesExecutionProfile,
): Promise<void> {
  const ownerUid = await api.createRunRoot(input);
  const manifests = ownedRunControlManifests(input, ownerUid, profile);
  await api.createExperimentAndQueue(input.namespace, manifests);
  await api.createControllerAccess(input.namespace, manifests);
  await api.createRouterService(input.namespace, manifests);
  await api.startController(input.namespace, manifests);
}

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore Effect-first application rules after the Temporal activity boundary. */
