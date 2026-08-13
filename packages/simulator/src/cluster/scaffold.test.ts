/* eslint-disable agent-code-guard/async-keyword -- Vitest awaits the Effect the activity boundary under test returns. */

import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  KubernetesCallFailed,
  type RunControlApi,
} from "./kubernetes/calls.js";
import {
  RUN_OWNER_NAME,
  type OwnedRunControlManifests,
} from "./kubernetes/objects.js";
import { LOCAL_KUBERNETES_EXECUTION_PROFILE } from "./profile.js";
import type { RunSocietyWorkflowInput } from "./reclaim.js";
import { prepareRun } from "./scaffold.js";

type PreparationStage = Extract<
  keyof RunControlApi,
  | "createRunRoot"
  | "createExperimentAndQueue"
  | "createControllerAccess"
  | "startController"
>;

// The run root issues the UID every other object is owned by, and the
// controller acts through the run-scoped RBAC the moment it starts, so it goes
// last. Nothing constrains the stages between them relative to each other.
const ROOT: PreparationStage = "createRunRoot";
const START: PreparationStage = "startController";
const BEFORE_START: readonly PreparationStage[] = [
  "createRunRoot",
  "createExperimentAndQueue",
  "createControllerAccess",
];
const DIGEST = "a".repeat(64);
const OWNER_UID = "owner-uid-the-cluster-issued";
const INPUT: RunSocietyWorkflowInput = {
  runId: "run-1",
  namespace: "mz-run-1",
  controllerImage: `registry/controller@sha256:${DIGEST}`,
  supportImage: `registry/support@sha256:${DIGEST}`,
  experimentModule: "export const runSpec = society;",
};

interface RecordedRunControl {
  readonly api: RunControlApi;
  readonly calls: PreparationStage[];
  readonly namespaces: string[];
  readonly manifests: OwnedRunControlManifests[];
}

function recordingRunControl(failAt?: PreparationStage): RecordedRunControl {
  const calls: PreparationStage[] = [];
  const namespaces: string[] = [];
  const manifests: OwnedRunControlManifests[] = [];
  const record = (
    stage: PreparationStage,
  ): Effect.Effect<void, KubernetesCallFailed> =>
    Effect.suspend(() => {
      calls.push(stage);
      return failAt === stage
        ? Effect.fail(new KubernetesCallFailed(stage))
        : Effect.void;
    });
  const owned =
    (stage: PreparationStage) =>
    (namespace: string, supplied: OwnedRunControlManifests) =>
      Effect.suspend(() => {
        namespaces.push(namespace);
        manifests.push(supplied);
        return record(stage);
      });
  return {
    calls,
    namespaces,
    manifests,
    api: {
      createRunRoot: () =>
        Effect.suspend(() => {
          calls.push(ROOT);
          return failAt === ROOT
            ? Effect.fail(new KubernetesCallFailed(ROOT))
            : Effect.succeed(OWNER_UID);
        }),
      createExperimentAndQueue: owned("createExperimentAndQueue"),
      createControllerAccess: owned("createControllerAccess"),
      startController: owned(START),
      readControllerJob: () =>
        Effect.fail(
          new KubernetesCallFailed("preparing a run observes nothing"),
        ),
      readControllerLogs: () => Effect.succeed(undefined),
      deleteRunNamespace: () => Effect.void,
      runNamespaceExists: () => Effect.succeed(false),
    },
  };
}

it("creates the run root before anything it owns and the controller last", async () => {
  const { api, calls, namespaces } = recordingRunControl();

  await Effect.runPromise(
    prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE),
  );

  expect(calls[0]).toBe(ROOT);
  expect(calls.at(-1)).toBe(START);
  expect(calls).toHaveLength(BEFORE_START.length + 1);
  expect(new Set(calls)).toEqual(new Set([...BEFORE_START, START]));
  expect(new Set(namespaces)).toEqual(new Set([INPUT.namespace]));
});

it("never starts a controller whose prerequisites failed to appear", async () => {
  for (const stage of BEFORE_START) {
    const { api, calls } = recordingRunControl(stage);

    const failure = await Effect.runPromise(
      Effect.flip(prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE)),
    );

    expect(failure.message).toBe(`${stage} failed`);
    expect(calls).toContain(stage);
    expect(calls).not.toContain(START);
  }
});

it("owns every created object by the run root the cluster just issued", async () => {
  const { api, manifests } = recordingRunControl();

  await Effect.runPromise(
    prepareRun(api, INPUT, LOCAL_KUBERNETES_EXECUTION_PROFILE),
  );

  const owners = manifests.flatMap((supplied) => [
    supplied.experiment.metadata?.ownerReferences,
    supplied.role.metadata?.ownerReferences,
    supplied.controllerJob.metadata?.ownerReferences,
  ]);
  expect(owners).not.toHaveLength(0);
  for (const ownerReferences of owners) {
    expect(ownerReferences).toEqual([
      expect.objectContaining({ name: RUN_OWNER_NAME, uid: OWNER_UID }),
    ]);
  }
});

/* eslint-enable agent-code-guard/async-keyword -- Restore Effect-first test rules after the activity preparation contract. */
